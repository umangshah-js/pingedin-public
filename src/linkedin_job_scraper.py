import os
import time
import re
import json
import traceback
from typing import Dict, List, Optional, Set
from datetime import datetime

import boto3
import urllib.parse
import urllib.error
import urllib.request
import subprocess
from html.parser import HTMLParser

from botocore.exceptions import ClientError
from decimal import Decimal

from augment_resume_from_jd import (
    fetch_url_text,
    fetch_url_text_selenium,
    extract_description_from_html as jd_extract_description_from_html,
    extract_description as jd_extract_description_text,
    process_jd_text,
    jd_skills as extract_jd_skills,
    extract_resume_skills,
    canonicalize,
)


DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/120.0.0.0 Safari/537.36"
)

USER_PROFILE_PREFIX = "__user__#"


def _json_default(value):
    if isinstance(value, Decimal):
        if value % 1 == 0:
            return int(value)
        return float(value)
    return str(value)


def _latex_escape(text: str) -> str:
    return (
        text.replace("\\", r"\textbackslash{}")
        .replace("&", r"\&")
        .replace("%", r"\%")
        .replace("$", r"\$")
        .replace("#", r"\#")
        .replace("_", r"\_")
        .replace("{", r"\{")
        .replace("}", r"\}")
        .replace("~", r"\textasciitilde{}")
        .replace("^", r"\textasciicircum{}")
    )


def _compile_tex_to_pdf(tex_path: str, out_dir: str) -> str:
    texlive_root = os.path.join("/tmp", "texlive")
    texmf_var = os.path.join(texlive_root, "texmf-var")
    texmf_config = os.path.join(texlive_root, "texmf-config")
    texmf_home = os.path.join(texlive_root, "texmf-home")
    for path in (texmf_var, texmf_config, texmf_home, os.path.join("/tmp", "fontconfig")):
        os.makedirs(path, exist_ok=True)

    cmd = [
        "xelatex",
        "-interaction=nonstopmode",
        "-halt-on-error",
        f"-output-directory={out_dir}",
        tex_path,
    ]
    env = os.environ.copy()
    env["HOME"] = "/tmp"
    env["FC_CACHEDIR"] = os.path.join("/tmp", "fontconfig")
    env["XDG_CACHE_HOME"] = "/tmp"
    env["TEXMFVAR"] = texmf_var
    env["TEXMFCONFIG"] = texmf_config
    env["TEXMFHOME"] = texmf_home
    env["VARTEXFONTS"] = os.path.join(texmf_var, "fonts")
    res = subprocess.run(cmd, cwd=out_dir, capture_output=True, text=True, env=env)
    if res.returncode != 0:
        raise RuntimeError(res.stdout + "\n" + res.stderr)
    return os.path.join(out_dir, os.path.splitext(os.path.basename(tex_path))[0] + ".pdf")


def _select_resume_tex(base_path: str, description: str) -> str:
    # Only apply cloud-specific auto-selection for the default base template.
    # If a custom template is explicitly selected (e.g. resume_2.tex), respect it.
    if os.path.basename(base_path) != "resume.tex":
        return base_path
    resume_dir = os.path.dirname(base_path)
    candidates = {
        "aws": os.path.join(resume_dir, "resume_aws.tex"),
        "gcp": os.path.join(resume_dir, "resume_gcp.tex"),
        "azure": os.path.join(resume_dir, "resume_azure.tex"),
    }
    jd_canons = extract_jd_skills(description) if description else []
    if "aws" in jd_canons and os.path.exists(candidates["aws"]):
        return candidates["aws"]
    if "gcp" in jd_canons and os.path.exists(candidates["gcp"]):
        return candidates["gcp"]
    if "azure" in jd_canons and os.path.exists(candidates["azure"]):
        return candidates["azure"]
    return base_path


def _render_cover_letter_tex(
    template_path: str,
    company: str,
    role: str,
    company_mission: str = "",
) -> str:
    with open(template_path, "r", encoding="utf-8") as handle:
        template = handle.read()
    company_safe = _latex_escape(company or "")
    role_safe = _latex_escape(role or "")
    mission_safe = _latex_escape(company_mission or "").strip()
    mission_paragraph = ""
    if mission_safe:
        mission_paragraph = mission_safe
        mission_paragraph += "\n\n"
    date_text = datetime.now().strftime("%m/%d/%Y")
    rendered = (
        template.replace("[Company]", company_safe)
        .replace("[Role]", role_safe)
        .replace("[CompanyMission]", mission_safe)
        .replace("[MissionParagraph]", mission_paragraph)
        .replace("[Date]", date_text)
    )
    if mission_paragraph and "[MissionParagraph]" not in template:
        mission_insert = mission_paragraph.strip()
        if "Dear Hiring Manager," in rendered:
            rendered = rendered.replace(
                "Dear Hiring Manager,",
                f"Dear Hiring Manager,\n\n{mission_insert}",
                1,
            )
        else:
            rendered = f"{mission_insert}\n\n{rendered}"
    return rendered


def _normalize_spaces(text: str) -> str:
    return re.sub(r"\s+", " ", str(text or "")).strip()


def _safe_filename_part(text: str, max_len: int = 40) -> str:
    """Sanitize a string for use in a PDF filename (spaces → underscores, strip special chars)."""
    cleaned = re.sub(r"[^\w\s-]", "", str(text or "")).strip()
    cleaned = re.sub(r"[\s]+", "_", cleaned)
    return cleaned[:max_len]


def _extract_json_object(text: str) -> Optional[Dict[str, object]]:
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        parsed = json.loads(text[start : end + 1])
        if isinstance(parsed, dict):
            return parsed
    except Exception:
        return None
    return None


def _extract_gemini_text(payload: Dict[str, object]) -> str:
    candidates = payload.get("candidates")
    if not isinstance(candidates, list):
        return ""
    for candidate in candidates:
        if not isinstance(candidate, dict):
            continue
        content = candidate.get("content")
        if not isinstance(content, dict):
            continue
        parts = content.get("parts")
        if not isinstance(parts, list):
            continue
        texts: List[str] = []
        for part in parts:
            if isinstance(part, dict):
                text = part.get("text")
                if isinstance(text, str) and text.strip():
                    texts.append(text.strip())
        if texts:
            return "\n".join(texts).strip()
    return ""


GEMINI_FREE_TIER_MODELS = [
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-2.0-flash",
    "gemini-2.0-flash-lite",
    "gemini-1.5-flash",
    "gemini-1.5-flash-8b",
]

_GEMINI_QUOTA_ERROR_CODES = {429, 503}


def _call_gemini_generate(config: "Config", prompt: str) -> str:
    if not config.gemini_api_key:
        return ""

    preferred = (config.gemini_model or "gemini-2.5-flash").strip()
    models_to_try = [preferred] + [m for m in GEMINI_FREE_TIER_MODELS if m != preferred]

    query = urllib.parse.urlencode({"key": config.gemini_api_key})
    payload: Dict[str, object] = {
        "contents": [
            {
                "role": "user",
                "parts": [{"text": prompt}],
            }
        ],
        "generationConfig": {
            "temperature": 0.2,
            "maxOutputTokens": 1500,
        },
    }
    body = json.dumps(payload).encode("utf-8")
    timeout_seconds = max(5, int(config.gemini_timeout_seconds))

    for model_name in models_to_try:
        endpoint = (
            "https://generativelanguage.googleapis.com/v1beta/models/"
            f"{urllib.parse.quote(model_name, safe='')}:generateContent"
        )
        req = urllib.request.Request(
            f"{endpoint}?{query}",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout_seconds) as resp:
                raw = resp.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as exc:
            err_text = ""
            try:
                err_text = exc.read().decode("utf-8", errors="replace")
            except Exception:
                err_text = ""
            if exc.code in _GEMINI_QUOTA_ERROR_CODES:
                print(f"Gemini model {model_name} quota/rate-limited ({exc.code}), trying next model...")
                continue
            print(f"Gemini API HTTP error ({exc.code}) with model {model_name}: {err_text}")
            return ""
        except Exception as exc:
            print(f"Gemini API request failed with model {model_name}: {exc}")
            return ""

        print(f"Gemini API success with model: {model_name}")
        print("Gemini API raw response JSON BEGIN")
        print(raw)
        print("Gemini API raw response JSON END")
        try:
            parsed = json.loads(raw)
        except Exception:
            return ""
        generated_text = _extract_gemini_text(parsed)
        print("Gemini extracted text BEGIN")
        print(generated_text)
        print("Gemini extracted text END")
        return generated_text

    print("Gemini API: all models exhausted (quota/rate-limited)")
    return ""


def _fetch_company_mission(
    config: "Config",
    company: str,
    role: str,
    description: str = "",
    job_url: str = "",
) -> str:
    if not config.cover_letter_mission_enabled:
        return ""
    company_name = _normalize_spaces(company)
    if not company_name:
        return ""
    if not config.gemini_api_key:
        return ""

    role_text = _normalize_spaces(role)
    jd_excerpt = _normalize_spaces(description)[:2000]
    job_url_text = _normalize_spaces(job_url)
    prompt = (
        "Write one polished paragraph for a cover letter.\n"
        f"Company: {company_name}\n"
        f"Role: {role_text}\n"
        f"Job URL: {job_url_text}\n"
        f"Job Description Excerpt: {jd_excerpt}\n\n"
        "Goal:\n"
        "- Mention what the company is trying to achieve (mission/impact) and align my motivation to it.\n"
        "- Keep it authentic and professional, suitable to paste directly into the cover letter.\n"
        "- 2 sentences max, 35-70 words total.\n\n"
        "Rules:\n"
        "- Return plain text only.\n"
        "- Do not return JSON, markdown, labels, bullets, or quote characters.\n"
        "- Do not end with a trailing fragment like 'and' or 'to'.\n"
        "- If unsure, return an empty string."
    )

    result_text = _call_gemini_generate(config, prompt)
    if not result_text:
        return ""

    parsed = _extract_json_object(result_text)
    mission = ""
    if parsed:
        for key in ("paragraph", "mission_paragraph", "mission", "text", "content"):
            maybe_value = parsed.get(key)
            if isinstance(maybe_value, str) and maybe_value.strip():
                mission = maybe_value
                break
    if not mission:
        mission = result_text

    mission = mission.strip()
    if mission.lower() in {"", "unknown", "none", "n/a", "not available", "not sure"}:
        return ""
    print(f"Gemini mission paragraph selected: {mission}")
    return mission


class Config:
    def __init__(self) -> None:
        self.keywords = os.getenv("LINKEDIN_KEYWORDS", "Data Engineer")
        self.location = os.getenv("LINKEDIN_LOCATION", "United States")
        self.geo_id = os.getenv("LINKEDIN_GEO_ID")
        self.time_posted = os.getenv("LINKEDIN_TPR", "r86400")
        self.max_tpr_seconds = int(os.getenv("MAX_TPR_SECONDS", "86400"))
        self.force_tpr = os.getenv("FORCE_TPR")
        self.debug_html = os.getenv("DEBUG_HTML", "false").lower() == "true"
        self.debug_matches = os.getenv("DEBUG_MATCHES", "false").lower() == "true"
        self.page_size = int(os.getenv("PAGE_SIZE", "25"))
        self.max_pages = int(os.getenv("MAX_PAGES", "4"))
        self.request_delay = float(os.getenv("REQUEST_DELAY_SECONDS", "0.6"))
        self.user_agent = os.getenv("USER_AGENT", DEFAULT_USER_AGENT)
        self.table_name = os.getenv("DYNAMODB_TABLE", "linkedin_jobs")
        self.pushover_user_key = os.getenv(
            "PUSHOVER_USER_KEY",
            "u4km6osr7t6w37h9pc4ncbd5o9yabo",
        )
        self.pushover_app_token = os.getenv("PUSHOVER_APP_TOKEN")
        self.pushover_app_token_secret_arn = os.getenv(
            "PUSHOVER_APP_TOKEN_SECRET_ARN"
        )
        self.role_keywords = self._parse_keywords(
            os.getenv("ROLE_KEYWORDS", "Data Engineer")
        )
        self.meta_key = os.getenv("META_KEY", "__meta__")
        self.last_success_attr = os.getenv("LAST_SUCCESS_ATTR", "lastSuccessEpoch")
        self.resume_s3_bucket = os.getenv("RESUME_S3_BUCKET")
        self.resume_s3_prefix = os.getenv("RESUME_S3_PREFIX", "resumes")
        self.resume_compile_pdf = os.getenv("RESUME_COMPILE_PDF", "true").lower() == "true"
        self.resume_url_expires_seconds = int(
            os.getenv("RESUME_URL_EXPIRES_SECONDS", "604800")
        )
        self.jd_fetch_mode = os.getenv("JD_FETCH_MODE", "urllib")
        self.template_root = os.getenv(
            "USER_TEMPLATES_ROOT",
            os.path.join(os.path.dirname(__file__), "users"),
        )
        self.default_template_user = os.getenv("DEFAULT_TEMPLATE_USER", "umang")
        self.resume_tex_path = os.getenv(
            "RESUME_TEX_PATH",
            os.path.join(self.template_root, self.default_template_user, "resume.tex"),
        )
        self.cover_letter_tex_path = os.getenv(
            "COVER_LETTER_TEX_PATH",
            os.path.join(self.template_root, self.default_template_user, "cover_letter.tex"),
        )
        self.cover_letter_mission_enabled = (
            os.getenv("COVER_LETTER_MISSION_ENABLED", "true").lower() == "true"
        )
        self.gemini_api_key = os.getenv("GEMINI_API_KEY", "").strip()
        self.gemini_api_key_secret_arn = os.getenv("GEMINI_API_KEY_SECRET_ARN", "").strip()
        self.gemini_model = os.getenv("GEMINI_MODEL", "gemini-2.5-flash").strip()
        self.gemini_timeout_seconds = int(os.getenv("GEMINI_TIMEOUT_SECONDS", "15"))
        self.resume_auto_generate = os.getenv(
            "RESUME_AUTO_GENERATE",
            "true",
        ).lower() == "true"
        self.portal_url_base = os.getenv("PORTAL_URL_BASE", "")
        self.skills_grouped_path = os.getenv(
            "SKILLS_GROUPED_PATH",
            os.path.join(self.template_root, self.default_template_user, "skills_grouped.json"),
        )
        self.replacement_rules_path = os.getenv(
            "REPLACEMENT_RULES_PATH",
            os.path.join(self.template_root, self.default_template_user, "replacement_rules.json"),
        )

        if not self.pushover_app_token and self.pushover_app_token_secret_arn:
            self.pushover_app_token = self._load_secret_token(
                self.pushover_app_token_secret_arn
            )
        if not self.gemini_api_key and self.gemini_api_key_secret_arn:
            self.gemini_api_key = (
                self._load_secret_token(self.gemini_api_key_secret_arn) or ""
            )

    @staticmethod
    def _parse_keywords(value: str) -> List[str]:
        return [kw.strip().lower() for kw in value.split(",") if kw.strip()]

    @staticmethod
    def parse_search_terms(value: object) -> List[str]:
        if isinstance(value, list):
            raw_terms: List[str] = []
            for item in value:
                raw_terms.extend(str(item or "").splitlines())
        else:
            raw_terms = str(value or "").splitlines()
        terms: List[str] = []
        seen: Set[str] = set()
        for raw in raw_terms:
            term = str(raw or "").strip()
            if not term:
                continue
            key = term.lower()
            if key in seen:
                continue
            seen.add(key)
            terms.append(term)
        return terms

    @staticmethod
    def _load_secret_token(secret_arn: str) -> Optional[str]:
        client = boto3.client("secretsmanager")
        response = client.get_secret_value(SecretId=secret_arn)
        token = response.get("SecretString")
        if token:
            return token.strip()
        return None

    @staticmethod
    def _normalize_template_user(value: Optional[str]) -> str:
        raw = str(value or "").strip().lower()
        if not raw:
            return ""
        return re.sub(r"[^a-z0-9_-]", "", raw)

    def apply_template_user(self, template_user: Optional[str]) -> bool:
        candidate = self._normalize_template_user(template_user)
        if not candidate:
            return False
        candidate_dir = os.path.join(self.template_root, candidate)
        if not os.path.isdir(candidate_dir):
            return False
        self.resume_tex_path = os.path.join(candidate_dir, "resume.tex")
        self.cover_letter_tex_path = os.path.join(candidate_dir, "cover_letter.tex")
        self.skills_grouped_path = os.path.join(candidate_dir, "skills_grouped.json")
        self.replacement_rules_path = os.path.join(candidate_dir, "replacement_rules.json")
        return True

    def list_resume_templates(self) -> List[str]:
        resume_dir = os.path.dirname(self.resume_tex_path)
        if not os.path.isdir(resume_dir):
            return []
        templates: List[str] = []
        try:
            for entry in sorted(os.listdir(resume_dir)):
                if not entry.endswith(".tex"):
                    continue
                if not entry.startswith("resume"):
                    continue
                if entry not in templates:
                    templates.append(entry)
        except Exception:
            return []
        if not templates:
            return []
        # Keep default template first for predictable UX.
        if "resume.tex" in templates:
            templates.remove("resume.tex")
            templates.insert(0, "resume.tex")
        return templates

    def apply_resume_template(self, template_name: Optional[str]) -> bool:
        raw = str(template_name or "").strip()
        if not raw:
            return False
        if os.path.basename(raw) != raw:
            return False
        if not raw.endswith(".tex"):
            return False
        if not raw.startswith("resume"):
            return False
        candidate_path = os.path.join(os.path.dirname(self.resume_tex_path), raw)
        if not os.path.isfile(candidate_path):
            return False
        self.resume_tex_path = candidate_path
        return True


class LinkedInGuestClient:
    SEARCH_URL = "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search"
    DETAIL_URL_TEMPLATE = "https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/{job_id}"

    def __init__(self, config: Config) -> None:
        self.config = config
        self.headers = {
            "User-Agent": config.user_agent,
            "Accept": "text/html,application/xhtml+xml",
            "Accept-Language": "en-US,en;q=0.9",
            "Referer": "https://www.linkedin.com/jobs/",
        }

    def fetch_search_page(self, start: int, keywords: Optional[str] = None) -> str:
        search_keywords = str(keywords or self.config.keywords).strip() or str(self.config.keywords).strip()
        search_keywords_lower = search_keywords.lower()
        params = {
            "keywords": search_keywords,
            "location": self.config.location,
            "f_TPR": self.config.time_posted,
            "start": start,
        }
        if "construction" in search_keywords_lower or "contruction" in search_keywords_lower:
            params["f_I"] = "48"
            print(f"Applying construction industry filter f_I=48 for keywords={search_keywords}")
        if self.config.geo_id:
            params["geoId"] = self.config.geo_id
        query = urllib.parse.urlencode(params)
        url = f"{self.SEARCH_URL}?{query}"
        print(f"LinkedIn search URL: {url}")
        req = urllib.request.Request(url, headers=self.headers)
        with urllib.request.urlopen(req, timeout=20) as resp:
            body = resp.read().decode("utf-8", errors="replace")
            print(f"LinkedIn search status: {resp.status}, body_len: {len(body)}")
            if self.config.debug_html:
                print("LinkedIn search HTML BEGIN")
                print(body)
                print("LinkedIn search HTML END")
            return body

    def fetch_job_detail(self, job_id: str) -> str:
        url = self.DETAIL_URL_TEMPLATE.format(job_id=job_id)
        req = urllib.request.Request(url, headers=self.headers)
        with urllib.request.urlopen(req, timeout=20) as resp:
            return resp.read().decode("utf-8", errors="replace")


class JobStore:
    def __init__(self, table) -> None:
        self.table = table

    def seen(self, job_id: str) -> bool:
        response = self.table.get_item(Key={"jobId": job_id}, ProjectionExpression="jobId")
        return "Item" in response

    def get(self, job_id: str) -> Optional[Dict[str, object]]:
        response = self.table.get_item(Key={"jobId": job_id})
        return response.get("Item")

    def save(self, job: Dict[str, str]) -> bool:
        try:
            self.table.put_item(
                Item=job,
                ConditionExpression="attribute_not_exists(jobId)",
            )
            return True
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
                return False
            raise

    def get_last_success(self, meta_key: str, attr: str) -> Optional[int]:
        response = self.table.get_item(Key={"jobId": meta_key})
        item = response.get("Item") or {}
        value = item.get(attr)
        if value is None:
            return None
        try:
            return int(value)
        except (TypeError, ValueError):
            return None

    def set_last_success(self, meta_key: str, attr: str, value: int) -> None:
        self.table.put_item(
            Item={
                "jobId": meta_key,
                attr: int(value),
            }
        )

    def update_fields(self, job_id: str, fields: Dict[str, object]) -> None:
        if not fields:
            return
        expr_parts = []
        names = {}
        values = {}
        for idx, (key, value) in enumerate(fields.items()):
            name = f"#f{idx}"
            val = f":v{idx}"
            names[name] = key
            values[val] = value
            expr_parts.append(f"{name} = {val}")
        self.table.update_item(
            Key={"jobId": job_id},
            UpdateExpression="SET " + ", ".join(expr_parts),
            ExpressionAttributeNames=names,
            ExpressionAttributeValues=values,
        )

    def add_user_membership(self, job_id: str, user_id: str) -> None:
        item = self.get(job_id) or {}
        user_ids = list(item.get("userIds") or [])
        if user_id in user_ids:
            return
        user_ids.append(user_id)
        self.update_fields(job_id, {"userIds": user_ids})

    def delete(self, job_id: str) -> None:
        self.table.delete_item(Key={"jobId": job_id})


class PushoverNotifier:
    API_URL = "https://api.pushover.net/1/messages.json"

    def __init__(self, user_key: str, app_token: str) -> None:
        self.user_key = user_key
        self.app_token = app_token

    def send(
        self,
        title: str,
        message: str,
        url: Optional[str] = None,
    ) -> bool:
        payload = {
            "token": self.app_token,
            "user": self.user_key,
            "title": title,
            "message": message,
            "html": "1",
        }
        if url:
            message += f'\n\n<a href="{url}"><b>View Job Analysis</b></a>'
            payload["message"] = message
        debug_payload = dict(payload)
        debug_payload["token"] = "***"
        debug_payload["user"] = "***"
        print(f"Pushover payload: {debug_payload}")
        data = urllib.parse.urlencode(payload).encode("utf-8")
        req = urllib.request.Request(self.API_URL, data=data, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                if resp.status >= 400:
                    print(f"Pushover request failed with status {resp.status}")
                    return False
        except urllib.error.HTTPError as exc:
            body = ""
            try:
                body = exc.read().decode("utf-8", errors="replace")
            except Exception:
                body = ""
            if body:
                body = body[:1000]
            print(f"Pushover HTTP error: {exc.code} {exc.reason} {body}")
            return False
        except Exception as exc:
            print(f"Pushover send failed: {exc}")
            return False
        return True


class ResumeStore:
    def __init__(self, bucket: str, prefix: str, url_expires_seconds: int) -> None:
        self.bucket = bucket
        self.prefix = prefix.strip("/")
        self.url_expires_seconds = url_expires_seconds
        self.s3 = boto3.client("s3")

    def key_for(self, job_id: str, filename: str) -> str:
        if self.prefix:
            return f"{self.prefix}/{job_id}/{filename}"
        return f"{job_id}/{filename}"

    def upload_bytes(self, key: str, payload: bytes, content_type: Optional[str] = None) -> None:
        extra = {"ContentType": content_type} if content_type else None
        if extra:
            self.s3.put_object(Bucket=self.bucket, Key=key, Body=payload, **extra)
        else:
            self.s3.put_object(Bucket=self.bucket, Key=key, Body=payload)

    def upload_text(self, key: str, text: str, content_type: str = "text/plain") -> None:
        self.upload_bytes(key, text.encode("utf-8"), content_type=content_type)

    def upload_file(self, key: str, path: str, content_type: Optional[str] = None) -> None:
        with open(path, "rb") as handle:
            payload = handle.read()
        self.upload_bytes(key, payload, content_type=content_type)

    def presigned_url(self, key: str) -> str:
        return self.s3.generate_presigned_url(
            "get_object",
            Params={"Bucket": self.bucket, "Key": key},
            ExpiresIn=self.url_expires_seconds,
        )

    def delete_keys(self, keys: List[str]) -> None:
        objects = [{"Key": key} for key in keys if key]
        if not objects:
            return
        self.s3.delete_objects(
            Bucket=self.bucket,
            Delete={"Objects": objects, "Quiet": True},
        )


def build_portal_url(base: str, job_id: str) -> str:
    if not base:
        return ""
    sep = "&" if "?" in base else "?"
    return f"{base}{sep}jobId={job_id}"


def store_job_assets(
    store: ResumeStore,
    job_record: Dict[str, str],
    description: str,
) -> Dict[str, str]:
    job_id = job_record["jobId"]
    jd_key = store.key_for(job_id, "job_description.txt")
    store.upload_text(jd_key, description, content_type="text/plain")
    job_record_key = store.key_for(job_id, "job_record.json")
    store.upload_text(
        job_record_key,
        json.dumps(job_record, indent=2, default=_json_default),
        content_type="application/json",
    )
    return {
        "jd_key": jd_key,
        "job_record_key": job_record_key,
    }


JOB_ID_REGEX = re.compile(r"jobPosting:(\d+)")
JOB_ID_FALLBACK_REGEX = re.compile(r"/jobs/view/[^\"?]+-(\d+)")
TAG_RE = re.compile(r"<[^>]+>")
TITLE_REGEX = re.compile(
    r"<h3[^>]*class=\"[^\"]*base-search-card__title[^\"]*\"[^>]*>(.*?)</h3>",
    re.DOTALL,
)
COMPANY_REGEX = re.compile(
    r"<h4[^>]*class=\"[^\"]*base-search-card__subtitle[^\"]*\"[^>]*>(.*?)</h4>",
    re.DOTALL,
)
LOCATION_REGEX = re.compile(
    r"<span[^>]*class=\"[^\"]*job-search-card__location[^\"]*\"[^>]*>(.*?)</span>",
    re.DOTALL,
)
COMP_RANGE_REGEX = re.compile(
    r"([$€£]\s?\d{2,3}(?:[,\d]{0,6})\s?(?:k|K)?\s?(?:-|to)\s?[$€£]?\s?\d{2,3}(?:[,\d]{0,6})\s?(?:k|K)?)"
)
COMP_SINGLE_REGEX = re.compile(r"([$€£]\s?\d{2,3}(?:[,\d]{0,6})\s?(?:k|K)?)")


class _TextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.parts: List[str] = []

    def handle_data(self, data: str) -> None:
        if data:
            self.parts.append(data)

    def get_text(self) -> str:
        return " ".join(part.strip() for part in self.parts if part.strip())


def _strip_tags(value: str) -> str:
    parser = _TextExtractor()
    parser.feed(value)
    return parser.get_text()


def parse_job_cards(html: str) -> List[Dict[str, str]]:
    cards: List[Dict[str, str]] = []
    job_ids = JOB_ID_REGEX.findall(html)
    if not job_ids:
        job_ids = JOB_ID_FALLBACK_REGEX.findall(html)
    titles = [_strip_tags(t).strip() for t in TITLE_REGEX.findall(html)]
    companies = [_strip_tags(c).strip() for c in COMPANY_REGEX.findall(html)]
    locations = [_strip_tags(l).strip() for l in LOCATION_REGEX.findall(html)]

    count = min(len(job_ids), len(titles))
    for idx in range(count):
        job_id = job_ids[idx]
        title = titles[idx] or "(untitled)"
        company = companies[idx] if idx < len(companies) else "(unknown)"
        location = locations[idx] if idx < len(locations) else ""
        cards.append(
            {
                "jobId": job_id,
                "title": title,
                "company": company or "(unknown)",
                "location": location or "",
                "url": f"https://www.linkedin.com/jobs/view/{job_id}",
            }
        )
    return cards


def extract_description(html: str) -> str:
    block_match = re.search(
        r"<div[^>]+class=\"[^\"]*show-more-less-html__markup[^\"]*\"[^>]*>(.*?)</div>",
        html,
        re.DOTALL,
    )
    if block_match:
        return _strip_tags(block_match.group(1))
    return _strip_tags(html)


def fetch_job_description(
    client: LinkedInGuestClient,
    job_url: str,
    job_id: str,
    fetch_mode: str,
) -> str:
    desc = ""
    html = ""
    try:
        html = fetch_url_text(job_url)
    except Exception as exc:
        print(f"URL fetch failed: {exc}")

    if html:
        desc = jd_extract_description_from_html(html)
        desc = jd_extract_description_text(desc)

    if not desc and job_id:
        try:
            detail_html = client.fetch_job_detail(job_id)
            desc = jd_extract_description_from_html(detail_html)
            desc = jd_extract_description_text(desc)
        except Exception as exc:
            print(f"Guest API fetch failed: {exc}")
    return desc.strip()


def generate_resume_assets(
    config: Config,
    store: ResumeStore,
    job_record: Dict[str, str],
    description: str,
) -> Dict[str, str]:
    if not config.resume_s3_bucket:
        raise RuntimeError("RESUME_S3_BUCKET env var is required for resume uploads")

    job_id = job_record["jobId"]
    tmp_dir = "/tmp"
    generated_at = int(time.time())
    out_tex = os.path.join(tmp_dir, f"resume_{job_id}.tex")
    out_pdf = os.path.join(tmp_dir, f"resume_{job_id}.pdf")
    resume_skills_path = os.path.join(tmp_dir, f"resume_skills_{job_id}.json")

    result = None
    error = None
    try:
        if not description:
            raise RuntimeError("Job description was empty")
        result = process_jd_text(
            description,
            config.skills_grouped_path,
            config.resume_tex_path,
            resume_skills_path,
            out_tex,
            out_pdf,
            config.replacement_rules_path,
            compile_pdf=config.resume_compile_pdf,
        )
    except BaseException as exc:
        error = str(exc)

    if error:
        head = error[:1000]
        tail = error[-1000:] if len(error) > 1000 else ""
        if tail:
            print(f"Resume generation error for job {job_id} (head): {head}")
            print(f"Resume generation error for job {job_id} (tail): {tail}")
        else:
            print(f"Resume generation error for job {job_id}: {head}")

    tex_key = store.key_for(job_id, "resume.tex")
    if os.path.exists(out_tex):
        store.upload_file(tex_key, out_tex, content_type="application/x-tex")

    company = job_record.get("company", "")
    role = job_record.get("title", "")
    pdf_filename = f"UmangShah_Resume_{_safe_filename_part(company)}_{_safe_filename_part(role)}.pdf"
    pdf_key = store.key_for(job_id, pdf_filename)
    pdf_uploaded = False
    if result and result.get("out_pdf") and os.path.exists(out_pdf):
        store.upload_file(pdf_key, out_pdf, content_type="application/pdf")
        pdf_uploaded = True
    if not pdf_uploaded:
        print(f"Resume PDF not uploaded for job {job_id}.")

    resume_skills_key = store.key_for(job_id, "resume_skills.json")
    if os.path.exists(resume_skills_path):
        store.upload_file(resume_skills_key, resume_skills_path, content_type="application/json")
    else:
        store.upload_text(
            resume_skills_key,
            json.dumps({"resume_skills_raw": [], "resume_skills_canonical": []}, indent=2),
            content_type="application/json",
        )

    augment_result_key = store.key_for(job_id, "augment_result.json")
    if result is not None:
        augment_payload = result
    else:
        augment_payload = {
            "error": error or "resume_generation_failed",
            "out_tex": out_tex if os.path.exists(out_tex) else "",
            "out_pdf": out_pdf if os.path.exists(out_pdf) else "",
        }
    store.upload_text(
        augment_result_key,
        json.dumps(augment_payload, indent=2),
        content_type="application/json",
    )
    if error:
        error_key = store.key_for(job_id, "resume_error.json")
        store.upload_text(
            error_key,
            json.dumps(
                {
                    "error": error,
                    "traceback": traceback.format_exc(),
                },
                indent=2,
            ),
            content_type="application/json",
        )

    jd_key = store.key_for(job_id, "job_description.txt")
    store.upload_text(jd_key, description, content_type="text/plain")

    job_record_key = store.key_for(job_id, "job_record.json")
    store.upload_text(
        job_record_key,
        json.dumps(job_record, indent=2, default=_json_default),
        content_type="application/json",
    )

    pdf_url = store.presigned_url(pdf_key) if pdf_uploaded else ""
    tex_url = store.presigned_url(tex_key)

    summary_pdf_key = store.key_for(job_id, "job_summary.pdf")
    summary_uploaded = False
    try:
        resume_link = ""
        short_base = os.getenv("RESUME_URL_BASE")
        if short_base:
            resume_link = f"{short_base}?{urllib.parse.urlencode({'jobId': job_id, 'type': 'resume'})}"
        elif pdf_url:
            resume_link = pdf_url

        changes = augment_payload if isinstance(augment_payload, dict) else {}
        added_skills = changes.get("added_skills") or []
        added_bullets = changes.get("added_bullets") or []
        jd_found = extract_jd_skills(description) if description else []
        resume_canons = []
        try:
            base_resume_path = _select_resume_tex(config.resume_tex_path, description)
            with open(base_resume_path, "r", encoding="utf-8") as handle:
                base_tex = handle.read()
            resume_canons = canonicalize(extract_resume_skills(base_tex))
        except Exception as exc:
            print(f"Failed to read base resume for summary: {exc}")

        jd_found_set = set(jd_found)
        resume_set = set(resume_canons)
        added_set = set(added_skills) | set(added_bullets)

        # Prefer concrete technologies over generic skills in the summary.
        generic_map = {
            'data warehouse': ['snowflake', 'redshift', 'bigquery'],
            'streaming': ['kafka', 'spark', 'pubsub'],
            'etl/elt': ['spark', 'airflow'],
            'db modeling': ['postgresql', 'snowflake'],
        }
        for generic, techs in generic_map.items():
            if generic not in jd_found_set:
                continue
            concrete_present = False
            for tech in techs:
                if tech in resume_set or tech in added_set or tech in jd_found_set:
                    concrete_present = True
                    jd_found_set.add(tech)
            if not concrete_present:
                # Pick a concrete tech to surface instead of the generic skill.
                for tech in techs:
                    if tech not in resume_set and tech not in jd_found_set:
                        jd_found_set.add(tech)
                        break
            # Always remove the generic skill from the summary lists.
            jd_found_set.discard(generic)

        # Final hard filter: never show generic skills in summary lists.
        generic_skills = set(generic_map.keys())
        jd_found_set -= generic_skills
        jd_found = sorted(jd_found_set)
        matched_in_resume = sorted(jd_found_set & resume_set)
        not_added = sorted(jd_found_set - resume_set - added_set)

        def _format_list(items: List[str]) -> str:
            if not items:
                return "None"
            return "\n".join([rf"\item {_latex_escape(item)}" for item in items])

        job_url = job_record.get("url", "")
        summary_tex = "\n".join(
            [
                r"\documentclass[11pt]{article}",
                r"\usepackage[margin=1in]{geometry}",
                r"\usepackage{hyperref}",
                r"\usepackage{enumitem}",
                r"\setlist{nosep}",
                r"\hypersetup{colorlinks=true,urlcolor=blue}",
                r"\begin{document}",
                rf"\section*{{Job Summary}}",
                rf"\textbf{{Title:}} {_latex_escape(job_record.get('title',''))}\\",
                rf"\textbf{{Company:}} {_latex_escape(job_record.get('company',''))}\\",
                rf"\textbf{{Location:}} {_latex_escape(job_record.get('location',''))}\\",
                r"\section*{Quick Links}",
                (r"\Large \href{" + job_url + r"}{Open Job Posting}\\"
                 if job_url else r"\Large Open Job Posting\\"),
                (r"\Large \href{" + resume_link + r"}{Open Custom Resume PDF}\\"
                 if resume_link else r"\Large Resume PDF Not Available\\"),
                r"\section*{Changes}",
                r"\textbf{Added Skills:}",
                r"\begin{itemize}" if added_skills else r"None",
                _format_list(added_skills) if added_skills else "",
                r"\end{itemize}" if added_skills else "",
                r"\textbf{Added Bullets:}",
                r"\begin{itemize}" if added_bullets else r"None",
                _format_list(added_bullets) if added_bullets else "",
                r"\end{itemize}" if added_bullets else "",
                r"\section*{Skills Found in JD}",
                r"\begin{itemize}" if jd_found else r"None",
                _format_list(jd_found) if jd_found else "",
                r"\end{itemize}" if jd_found else "",
                r"\section*{Matched vs Not Added}",
                r"\textbf{Matched in Resume (already present):}",
                r"\begin{itemize}" if matched_in_resume else r"None",
                _format_list(matched_in_resume) if matched_in_resume else "",
                r"\end{itemize}" if matched_in_resume else "",
                r"\textbf{Could Not Be Added:}",
                r"\begin{itemize}" if not_added else r"None",
                _format_list(not_added) if not_added else "",
                r"\end{itemize}" if not_added else "",
                r"\section*{Job Description}",
                r"\noindent " + _latex_escape(description).replace("\n", r"\\"),
                r"\end{document}",
            ]
        )
        summary_tex_path = os.path.join(tmp_dir, f"job_summary_{job_id}.tex")
        with open(summary_tex_path, "w", encoding="utf-8") as handle:
            handle.write(summary_tex)
        summary_pdf_path = _compile_tex_to_pdf(summary_tex_path, tmp_dir)
        if os.path.exists(summary_pdf_path):
            store.upload_file(summary_pdf_key, summary_pdf_path, content_type="application/pdf")
            summary_uploaded = True
    except Exception as exc:
        print(f"Summary PDF generation failed for job {job_id}: {exc}")

    return {
        "pdf_key": pdf_key,
        "pdf_filename": pdf_filename,
        "tex_key": tex_key,
        "resume_skills_key": resume_skills_key,
        "augment_result_key": augment_result_key,
        "jd_key": jd_key,
        "job_record_key": job_record_key,
        "pdf_url": pdf_url,
        "tex_url": tex_url,
        "pdf_uploaded": pdf_uploaded,
        "summary_pdf_key": summary_pdf_key,
        "summary_pdf_uploaded": summary_uploaded,
        "generated_at": generated_at,
    }


def generate_cover_letter_assets(
    config: Config,
    store: ResumeStore,
    job_record: Dict[str, str],
    description: str = "",
    manual_triggered: bool = False,
) -> Dict[str, str]:
    if not config.resume_s3_bucket:
        raise RuntimeError("RESUME_S3_BUCKET env var is required for cover letter uploads")

    job_id = job_record["jobId"]
    tmp_dir = "/tmp"
    generated_at = int(time.time())

    out_tex = os.path.join(tmp_dir, f"cover_letter_{job_id}.tex")
    out_pdf = os.path.join(tmp_dir, f"cover_letter_{job_id}.pdf")

    company = job_record.get("company", "")
    role = job_record.get("title", "")
    organization_mission = ""
    if manual_triggered:
        organization_mission = _fetch_company_mission(
            config,
            company=company,
            role=role,
            description=description,
            job_url=str(job_record.get("url") or ""),
        )
    try:
        rendered = _render_cover_letter_tex(
            config.cover_letter_tex_path,
            company,
            role,
            company_mission=organization_mission,
        )
        with open(out_tex, "w", encoding="utf-8") as handle:
            handle.write(rendered)
    except Exception as exc:
        raise RuntimeError(f"Cover letter template rendering failed: {exc}") from exc

    pdf_uploaded = False
    pdf_key = ""
    pdf_filename = f"UmangShah_CoverLetter_{_safe_filename_part(company)}_{_safe_filename_part(role)}.pdf"
    tex_key = store.key_for(job_id, "cover_letter.tex")
    store.upload_file(tex_key, out_tex, content_type="application/x-tex")

    try:
        built_pdf = _compile_tex_to_pdf(out_tex, tmp_dir)
        if os.path.exists(built_pdf):
            pdf_key = store.key_for(job_id, pdf_filename)
            store.upload_file(pdf_key, built_pdf, content_type="application/pdf")
            pdf_uploaded = True
    except Exception as exc:
        print(f"Cover letter PDF generation failed for job {job_id}: {exc}")

    pdf_url = store.presigned_url(pdf_key) if pdf_uploaded and pdf_key else ""

    return {
        "cover_letter_pdf_key": pdf_key,
        "cover_letter_pdf_filename": pdf_filename,
        "cover_letter_tex_key": tex_key,
        "cover_letter_pdf_uploaded": pdf_uploaded,
        "cover_letter_generated_at": generated_at,
        "cover_letter_pdf_url": pdf_url,
        "organization_mission": organization_mission,
    }


def matches_role(title: str, description: str, keywords: List[str]) -> bool:
    title_l = title.lower()
    desc_l = description.lower()
    return any(kw in title_l or kw in desc_l for kw in keywords)


def extract_compensation(description: str) -> Optional[str]:
    if not description:
        return None
    match = COMP_RANGE_REGEX.search(description)
    if match:
        return match.group(1).strip()
    match = COMP_SINGLE_REGEX.search(description)
    if match:
        return match.group(1).strip()
    return None


def format_message(job: Dict[str, str]) -> str:
    lines = [
        f"<b>Role:</b> {job.get('title', '').strip()}",
        f"<b>Company:</b> {job.get('company', '').strip()}",
        f"<b>Location:</b> {job.get('location', '').strip()}",
    ]
    comp = job.get("compensation")
    if comp:
        lines.append(f"<b>Comp:</b> {comp}")
    job_url = job.get("url")
    if job_url:
        lines.append(f"<b>Job:</b> <a href=\"{job_url}\">View on LinkedIn</a>")
    return "\n".join([line for line in lines if line.split(':', 1)[-1].strip()])


def run(
    config: Config,
    table,
    notifier: Optional[PushoverNotifier],
    user_id: Optional[str] = None,
    user_profile: Optional[Dict[str, object]] = None,
) -> Dict[str, int]:
    if user_profile:
        template_user = str(
            user_profile.get("templateUser")
            or user_profile.get("username")
            or ""
        ).strip()
        config.apply_template_user(template_user)

    if user_profile:
        config.keywords = str(user_profile.get("keywords") or config.keywords)
        config.location = str(user_profile.get("location") or config.location)

    client = LinkedInGuestClient(config)
    store = JobStore(table)

    if not config.resume_s3_bucket:
        raise RuntimeError("RESUME_S3_BUCKET env var is required to generate resumes")
    resume_store = ResumeStore(
        bucket=config.resume_s3_bucket,
        prefix=config.resume_s3_prefix,
        url_expires_seconds=config.resume_url_expires_seconds,
    )

    stats = {"fetched": 0, "new": 0, "notified": 0}
    notify_failed = False
    if config.force_tpr:
        client.config.time_posted = config.force_tpr
        print(f"Using forced f_TPR={client.config.time_posted}")
    else:
        last_success = None
        if user_profile and user_profile.get(config.last_success_attr) is not None:
            try:
                last_success = int(user_profile.get(config.last_success_attr))
            except Exception:
                last_success = None
        if last_success is None:
            last_success = store.get_last_success(config.meta_key, config.last_success_attr)
        if last_success:
            delta = max(1, int(time.time()) - last_success)
            delta = min(delta, config.max_tpr_seconds)
            client.config.time_posted = f"r{delta}"
            print(f"Using dynamic f_TPR={client.config.time_posted} based on lastSuccessEpoch")
        else:
            print(f"Using configured f_TPR={client.config.time_posted} (no lastSuccessEpoch)")
    search_terms = Config.parse_search_terms(config.keywords)
    if not search_terms:
        fallback = str(config.keywords or "").strip() or "Data Engineer"
        search_terms = [fallback]
    print(f"Searching {len(search_terms)} role term(s): {', '.join(search_terms)}")
    seen_job_ids: Set[str] = set()

    for term in search_terms:
        print(f"Starting LinkedIn role search for: {term}")
        start = 0
        for _page in range(config.max_pages):
            html = client.fetch_search_page(start, keywords=term)
            cards = parse_job_cards(html)
            print(f"Parsed {len(cards)} job cards on start={start} for keywords={term}")
            if not cards:
                break

            for card in cards:
                stats["fetched"] += 1
                job_id = card["jobId"]
                if job_id in seen_job_ids:
                    continue
                seen_job_ids.add(job_id)

                existing_item = store.get(job_id)
                existing_user_ids = list((existing_item or {}).get("userIds") or [])
                if user_id and user_id in existing_user_ids:
                    continue
                if not user_id and existing_item:
                    continue

                description = fetch_job_description(
                    client,
                    card["url"],
                    job_id,
                    config.jd_fetch_mode,
                )
                time.sleep(config.request_delay)

                compensation = extract_compensation(description) if description else None
                job_record = {
                    "jobId": job_id,
                    "title": card["title"],
                    "company": card["company"],
                    "location": card["location"],
                    "url": card["url"],
                    "seenAt": int(time.time()),
                }
                if compensation:
                    job_record["compensation"] = compensation
                if user_id:
                    job_record["userIds"] = [user_id]

                created_new = False
                if existing_item is None:
                    created_new = store.save(job_record)
                elif user_id:
                    store.add_user_membership(job_id, user_id)
                    created_new = True

                if created_new:
                    stats["new"] += 1
                    resume_assets = None
                    cleanup_keys: List[str] = []
                    jd_skills = extract_jd_skills(description) if description else []
                    try:
                        if config.resume_auto_generate and existing_item is None:
                            resume_assets = generate_resume_assets(
                                config,
                                resume_store,
                                job_record,
                                description,
                            )
                            cleanup_keys = [
                                resume_assets.get("tex_key"),
                                resume_assets.get("pdf_key"),
                                resume_assets.get("resume_skills_key"),
                                resume_assets.get("augment_result_key"),
                                resume_assets.get("jd_key"),
                                resume_assets.get("job_record_key"),
                            ]
                            if resume_assets.get("error"):
                                cleanup_keys.append(resume_store.key_for(job_id, "resume_error.json"))
                            resume_fields = {
                                "resumeS3Bucket": config.resume_s3_bucket,
                                "resumeS3Key": resume_assets["pdf_key"],
                                "resumePdfFilename": resume_assets.get("pdf_filename", ""),
                                "resumeGeneratedAt": resume_assets.get("generated_at", 0),
                                "resumeTexS3Key": resume_assets["tex_key"],
                                "resumeUrl": resume_assets.get("pdf_url", ""),
                                "resumePdfUploaded": resume_assets.get("pdf_uploaded", False),
                                "summaryS3Key": resume_assets.get("summary_pdf_key", ""),
                                "summaryPdfUploaded": resume_assets.get("summary_pdf_uploaded", False),
                                "resumeAugmentResultKey": resume_assets["augment_result_key"],
                                "resumeSkillsKey": resume_assets["resume_skills_key"],
                                "resumeJobDescriptionKey": resume_assets["jd_key"],
                                "resumeJobRecordKey": resume_assets["job_record_key"],
                                "jdSkills": jd_skills,
                                "jdSkillsUpdatedAt": int(time.time()),
                            }
                            job_record.update(resume_fields)
                            store.update_fields(job_id, resume_fields)
                        elif existing_item is None:
                            asset_keys = store_job_assets(resume_store, job_record, description)
                            resume_fields = {
                                "resumeS3Bucket": config.resume_s3_bucket,
                                "resumeJobDescriptionKey": asset_keys["jd_key"],
                                "resumeJobRecordKey": asset_keys["job_record_key"],
                                "resumePdfUploaded": False,
                                "summaryPdfUploaded": False,
                                "jdSkills": jd_skills,
                                "jdSkillsUpdatedAt": int(time.time()),
                            }
                            job_record.update(resume_fields)
                            store.update_fields(job_id, resume_fields)
                        else:
                            # Existing job claimed by another user: keep JD skills fresh.
                            store.update_fields(
                                job_id,
                                {
                                    "jdSkills": jd_skills,
                                    "jdSkillsUpdatedAt": int(time.time()),
                                },
                            )
                    except Exception as exc:
                        print(f"Resume handling failed for job {job_id}: {exc}")
                    if notifier:
                        title = f"{job_record['title']} @ {job_record['company']}"
                        message = format_message(job_record)
                        if resume_assets:
                            short_base = os.getenv("RESUME_URL_BASE")
                            summary_link = ""
                            resume_link = ""
                            if short_base and resume_assets.get("summary_pdf_uploaded"):
                                summary_link = (
                                    f"{short_base}?"
                                    f"{urllib.parse.urlencode({'jobId': job_id, 'type': 'summary'})}"
                                )
                            if short_base and resume_assets.get("pdf_uploaded"):
                                resume_link = (
                                    f"{short_base}?"
                                    f"{urllib.parse.urlencode({'jobId': job_id, 'type': 'resume'})}"
                                )
                            elif resume_assets.get("pdf_url"):
                                resume_link = resume_assets["pdf_url"]
                            if summary_link:
                                message += (
                                    "\n<b>Summary:</b> "
                                    f"<a href=\"{summary_link}\">Job Summary PDF</a>"
                                )
                            if resume_link:
                                message += (
                                    "\n<b>Resume:</b> "
                                    f"<a href=\"{resume_link}\">Custom Resume PDF</a>"
                                )
                        portal_url = build_portal_url(config.portal_url_base, job_id)
                        ok = notifier.send(
                            title=title,
                            message=message,
                            url=portal_url or job_record["url"],
                        )
                        if ok:
                            stats["notified"] += 1
                        else:
                            notify_failed = True
                            if existing_item is None:
                                try:
                                    store.delete(job_id)
                                except Exception as exc:
                                    print(f"Failed to delete job {job_id} after notify failure: {exc}")
                                try:
                                    resume_store.delete_keys(cleanup_keys)
                                except Exception as exc:
                                    print(f"Failed to delete resume assets for {job_id}: {exc}")
                            raise RuntimeError("Pushover notification failed")
                time.sleep(config.request_delay)

            if len(cards) < config.page_size:
                break
            start += config.page_size
            time.sleep(config.request_delay)

    if notifier and stats["new"] == 0 and not notify_failed:
        keyword_summary = ", ".join(search_terms)
        summary = (
            f"<b>No new jobs found</b>\n"
            f"<b>Keywords:</b> {keyword_summary}\n"
            f"<b>Location:</b> {config.location}\n"
            f"<b>Window:</b> {client.config.time_posted}"
        )
        notifier.send(title="LinkedIn Jobs Update", message=summary)

    if not notify_failed:
        if user_id:
            try:
                table.update_item(
                    Key={"jobId": f"{USER_PROFILE_PREFIX}{user_id}"},
                    UpdateExpression="SET #attr = :val, #updatedAt = :updatedAt",
                    ExpressionAttributeNames={
                        "#attr": config.last_success_attr,
                        "#updatedAt": "updatedAt",
                    },
                    ExpressionAttributeValues={
                        ":val": int(time.time()),
                        ":updatedAt": int(time.time()),
                    },
                )
            except Exception as exc:
                print(f"Failed to set per-user last success for {user_id}: {exc}")
        else:
            store.set_last_success(config.meta_key, config.last_success_attr, int(time.time()))
    return stats


def load_overrides(path: str) -> None:
    if not path:
        return
    if not os.path.exists(path):
        raise FileNotFoundError(path)
    with open(path, "r", encoding="utf-8") as handle:
        data = json.load(handle)
    for key, value in data.items():
        os.environ[str(key)] = str(value)
