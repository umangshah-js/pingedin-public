import json
import os
import re
import time
import hashlib
import urllib.parse
from decimal import Decimal
from typing import Any, Dict, Optional, Tuple
from zoneinfo import ZoneInfo

import boto3
from botocore.exceptions import ClientError

from augment_resume_from_jd import (
    GENERIC_SKILL_TECH,
    fetch_url_text,
    fetch_url_text_selenium,
    extract_linkedin_job_id,
    fetch_linkedin_guest_html,
    extract_description_from_html as jd_extract_description_from_html,
    extract_description as jd_extract_description_text,
)
from linkedin_job_scraper import (
    Config,
    PushoverNotifier,
    ResumeStore,
    generate_cover_letter_assets,
    generate_resume_assets,
    LinkedInGuestClient,
    fetch_job_description,
    extract_jd_skills,
    extract_resume_skills,
    canonicalize,
    _select_resume_tex,
)


def _json_default(value):
    if isinstance(value, Decimal):
        if value % 1 == 0:
            return int(value)
        return float(value)
    return str(value)


def _response(status: int, body: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "statusCode": status,
        "headers": {
            "content-type": "application/json",
        },
        "body": json.dumps(body, default=_json_default),
    }


def _error_response(status: int, message: str) -> Dict[str, Any]:
    return _response(status, {"error": message})


def _get_param(event: Dict[str, Any], name: str) -> Optional[str]:
    params = event.get("queryStringParameters") or {}
    if isinstance(params, dict):
        return params.get(name)
    return None


def _get_method(event: Dict[str, Any]) -> str:
    if "requestContext" in event and "http" in event["requestContext"]:
        return event["requestContext"]["http"].get("method", "")
    return event.get("httpMethod", "")


def _get_path(event: Dict[str, Any]) -> str:
    return event.get("rawPath") or event.get("path") or "/"


def _get_json_body(event: Dict[str, Any]) -> Dict[str, Any]:
    body = event.get("body")
    if not body:
        return {}
    if isinstance(body, dict):
        return body
    if not isinstance(body, str):
        return {}
    try:
        parsed = json.loads(body)
        if isinstance(parsed, dict):
            return parsed
    except Exception:
        return {}
    return {}


def _get_authorization_header(event: Dict[str, Any]) -> str:
    headers = event.get("headers") or {}
    if not isinstance(headers, dict):
        return ""
    for key in ("authorization", "Authorization"):
        value = headers.get(key)
        if isinstance(value, str):
            return value.strip()
    return ""


def _extract_bearer_token(event: Dict[str, Any]) -> str:
    auth_header = _get_authorization_header(event)
    if not auth_header:
        return ""
    parts = auth_header.split(" ", 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        return ""
    return parts[1].strip()


def _extract_identity(user_info: Dict[str, Any]) -> Dict[str, str]:
    attributes = user_info.get("UserAttributes") or []
    sub = ""
    for attr in attributes:
        if isinstance(attr, dict) and attr.get("Name") == "sub":
            sub = str(attr.get("Value") or "").strip()
            break
    username = str(user_info.get("Username") or "").strip()
    user_id = sub or username
    return {
        "sub": sub,
        "username": username,
        "userId": user_id,
    }


def _validate_access_token(access_token: str) -> Tuple[bool, str, Dict[str, str]]:
    if not access_token:
        return False, "Missing bearer token", {}
    user_pool_id = os.getenv("COGNITO_USER_POOL_ID", "").strip()
    client_id = os.getenv("COGNITO_APP_CLIENT_ID", "").strip()
    region = os.getenv("COGNITO_REGION", "").strip()
    if not user_pool_id or not client_id or not region:
        return False, "Cognito auth is not configured", {}
    cognito_idp = boto3.client("cognito-idp", region_name=region)
    try:
        user_info = cognito_idp.get_user(AccessToken=access_token)
        return True, "", _extract_identity(user_info)
    except cognito_idp.exceptions.NotAuthorizedException:
        return False, "Invalid or expired token", {}
    except Exception:
        return False, "Token validation failed", {}


def _user_profile_key(user_id: str) -> str:
    return f"__user__#{user_id}"


def _normalize_role_keywords(value: Any, fallback: str) -> list[str]:
    source: Any = value
    if source is None:
        source = fallback
    if isinstance(source, list):
        raw_terms: list[str] = []
        for item in source:
            raw_terms.extend(str(item or "").splitlines())
    else:
        raw_terms = str(source or "").splitlines()
    result: list[str] = []
    seen: set[str] = set()
    for raw in raw_terms:
        term = str(raw or "").strip()
        if not term:
            continue
        key = term.lower()
        if key in seen:
            continue
        seen.add(key)
        result.append(term)
    if result:
        return result
    return [kw.strip() for kw in str(fallback or "").splitlines() if kw.strip()]


def _parse_bool(value: Any, default: bool) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in ("true", "1", "yes", "on"):
            return True
        if lowered in ("false", "0", "no", "off"):
            return False
    return default


def _can_claim_legacy_jobs(identity: Dict[str, str]) -> bool:
    username = str(identity.get("username") or "").strip().lower()
    return username == "umang"


def _is_admin(identity: Dict[str, str]) -> bool:
    return str(identity.get("username") or "").strip().lower() == "umang"


def _load_user_profiles(table) -> list[Dict[str, Any]]:
    scan_kwargs = {
        "ProjectionExpression": (
            "jobId, userId, username, templateUser, keywords, #loc, enabled, "
            "notificationUserKey, scheduleEnabled, scheduleTimezone, scheduleStart, scheduleEnd, updatedAt"
        ),
        "ExpressionAttributeNames": {"#loc": "location"},
    }
    resp = table.scan(**scan_kwargs)
    items = list(resp.get("Items") or [])
    while resp.get("LastEvaluatedKey"):
        resp = table.scan(ExclusiveStartKey=resp["LastEvaluatedKey"], **scan_kwargs)
        items.extend(resp.get("Items") or [])
    profiles: list[Dict[str, Any]] = []
    for item in items:
        job_id = str(item.get("jobId") or "")
        if not job_id.startswith("__user__#"):
            continue
        user_id = str(item.get("userId") or "").strip() or job_id.replace("__user__#", "", 1)
        profiles.append(
            {
                "jobId": job_id,
                "userId": user_id,
                "username": str(item.get("username") or "").strip().lower(),
                "templateUser": str(item.get("templateUser") or "").strip().lower(),
                "keywords": str(item.get("keywords") or ""),
                "location": str(item.get("location") or ""),
                "enabled": bool(item.get("enabled", True)),
                "notificationUserKey": str(item.get("notificationUserKey") or ""),
                "scheduleEnabled": bool(item.get("scheduleEnabled", False)),
                "scheduleTimezone": str(item.get("scheduleTimezone") or "America/New_York"),
                "scheduleStart": str(item.get("scheduleStart") or "09:00"),
                "scheduleEnd": str(item.get("scheduleEnd") or "17:00"),
                "updatedAt": int(item.get("updatedAt") or 0),
            }
        )
    profiles.sort(key=lambda it: it.get("username") or it.get("userId"))
    return profiles


def _find_profile_by_identifier(profiles: list[Dict[str, Any]], identifier: str) -> Optional[Dict[str, Any]]:
    wanted = str(identifier or "").strip().lower()
    if not wanted:
        return None
    for profile in profiles:
        username = str(profile.get("username") or "").strip().lower()
        user_id = str(profile.get("userId") or "").strip().lower()
        if wanted == username or wanted == user_id:
            return profile
    return None


def _claim_legacy_job(table, item: Dict[str, Any], user_id: str) -> Dict[str, Any]:
    job_id = str(item.get("jobId") or "").strip()
    if not job_id:
        return item
    user_ids = item.get("userIds")
    if isinstance(user_ids, list) and user_ids:
        return item
    try:
        resp = table.update_item(
            Key={"jobId": job_id},
            UpdateExpression="SET #u = :u, #updatedAt = :updatedAt",
            ConditionExpression="attribute_not_exists(#u)",
            ExpressionAttributeNames={"#u": "userIds", "#updatedAt": "updatedAt"},
            ExpressionAttributeValues={":u": [user_id], ":updatedAt": int(time.time())},
            ReturnValues="ALL_NEW",
        )
        return resp.get("Attributes") or {**item, "userIds": [user_id]}
    except ClientError:
        latest = table.get_item(Key={"jobId": job_id}).get("Item")
        return latest or item


def _default_user_settings(config: Config) -> Dict[str, Any]:
    return {
        "keywords": config.keywords,
        "location": config.location,
        "enabled": True,
        "scheduleEnabled": False,
        "scheduleTimezone": "America/New_York",
        "scheduleStart": "09:00",
        "scheduleEnd": "17:00",
    }


def _parse_hhmm(value: str) -> Optional[int]:
    raw = str(value or "").strip()
    parts = raw.split(":")
    if len(parts) != 2:
        return None
    try:
        hour = int(parts[0])
        minute = int(parts[1])
    except Exception:
        return None
    if hour < 0 or hour > 23 or minute < 0 or minute > 59:
        return None
    return hour * 60 + minute


def _window_duration_minutes(start_hhmm: str, end_hhmm: str) -> Optional[int]:
    start = _parse_hhmm(start_hhmm)
    end = _parse_hhmm(end_hhmm)
    if start is None or end is None:
        return None
    if end >= start:
        return end - start
    return (24 * 60 - start) + end


def _get_or_create_user_profile(
    table,
    user_id: str,
    config: Config,
    identity: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    key = _user_profile_key(user_id)
    resp = table.get_item(Key={"jobId": key})
    item = resp.get("Item")
    if item:
        identity_username = str((identity or {}).get("username") or "").strip().lower()
        if identity_username and not str(item.get("username") or "").strip():
            table.update_item(
                Key={"jobId": key},
                UpdateExpression="SET #username = :username, #templateUser = if_not_exists(#templateUser, :templateUser), #updatedAt = :updatedAt",
                ExpressionAttributeNames={"#username": "username", "#templateUser": "templateUser", "#updatedAt": "updatedAt"},
                ExpressionAttributeValues={
                    ":username": identity_username,
                    ":templateUser": identity_username,
                    ":updatedAt": int(time.time()),
                },
            )
            item["username"] = identity_username
            if not str(item.get("templateUser") or "").strip():
                item["templateUser"] = identity_username
        return item
    username = str((identity or {}).get("username") or "").strip().lower()
    defaults = _default_user_settings(config)
    item = {
        "jobId": key,
        "itemType": "userProfile",
        "userId": user_id,
        "username": username,
        "templateUser": username or config.default_template_user,
        "updatedAt": int(time.time()),
        **defaults,
    }
    table.put_item(Item=item)
    return item


def _load_s3_text(s3, bucket: str, key: str) -> str:
    obj = s3.get_object(Bucket=bucket, Key=key)
    return obj["Body"].read().decode("utf-8", errors="replace")


def _tex_to_plain_text(tex: str) -> str:
    """Extract plain text from a cover letter .tex file, preserving paragraph breaks."""
    import re as _re
    # Keep only the document body
    body = _re.sub(r"[\s\S]*?\\begin\{document\}", "", tex)
    body = _re.sub(r"\\end\{document\}[\s\S]*", "", body)
    # Strip known structural commands
    body = _re.sub(r"\\(pagestyle|usepackage|setlength|documentclass|noindent)\b(\{[^}]*\})*", "", body)
    body = _re.sub(r"\\(par|noindent)\b", "", body)
    body = _re.sub(r"\\vspace\{[^}]*\}", "", body)
    # Unwrap common formatting commands
    body = _re.sub(r"\\textbf\{([^}]*)\}", r"\1", body)
    body = _re.sub(r"\\textit\{([^}]*)\}", r"\1", body)
    body = _re.sub(r"\\emph\{([^}]*)\}", r"\1", body)
    # Strip line-break markers
    body = body.replace(r"\\", "")
    # Strip remaining LaTeX commands and braces
    body = _re.sub(r"\\[a-zA-Z]+\*?(\{[^}]*\})*", "", body)
    body = body.replace("{", "").replace("}", "")
    # Normalise whitespace: collapse 3+ newlines → paragraph break
    body = _re.sub(r"\n{3,}", "\n\n", body)
    return body.strip()


def _derive_job_id_from_url(url: str) -> str:
    raw = str(url or "").strip()
    if not raw:
        return ""
    linkedin_job_id = extract_linkedin_job_id(raw)
    if linkedin_job_id:
        return linkedin_job_id
    try:
        parsed = urllib.parse.urlparse(raw)
        parts = [p for p in parsed.path.split("/") if p]
        if parts:
            candidate = urllib.parse.unquote(parts[-1]).strip().lower()
            safe = "".join(ch if ch.isalnum() or ch in ("-", "_", ".") else "-" for ch in candidate).strip("-")
            if safe:
                return f"custom-{safe[:96]}"
    except Exception:
        pass
    digest = hashlib.sha1(raw.encode("utf-8", errors="ignore")).hexdigest()[:16]
    return f"custom-{digest}"


def _normalize_job_url(url: str) -> str:
    raw = str(url or "").strip()
    if not raw:
        return ""
    if raw.startswith("www.") or raw.startswith("linkedin.com/"):
        raw = f"https://{raw}"
    parsed = urllib.parse.urlparse(raw)
    if parsed.scheme not in ("http", "https"):
        return ""
    if not parsed.netloc:
        return ""
    return raw


def _fetch_description_from_url(url: str, fetch_mode: str) -> str:
    if not url:
        return ""
    html = ""
    try:
        if fetch_mode == "selenium":
            html = fetch_url_text_selenium(url)
        else:
            html = fetch_url_text(url)
    except Exception:
        html = ""
    if not html:
        return ""
    desc = jd_extract_description_from_html(html)
    desc = jd_extract_description_text(desc)
    return desc.strip()


def _strip_html_tags(text: str) -> str:
    return re.sub(r"<[^>]+>", " ", text).strip()


def _parse_job_metadata_from_html(html: str) -> Dict[str, str]:
    """Extract title, company, location from a job page HTML. Returns empty strings on miss."""
    result: Dict[str, str] = {"title": "", "company": "", "location": ""}
    if not html:
        return result
    # Try JSON-LD first (full job pages)
    blocks = re.findall(r'<script[^>]*type=["\']application/ld\+json["\'][^>]*>(.*?)</script>', html, re.S | re.I)
    for block in blocks:
        try:
            data = json.loads(block.strip())
        except Exception:
            continue
        if isinstance(data, list):
            data = next((d for d in data if isinstance(d, dict) and d.get("@type") == "JobPosting"), None)
        if not isinstance(data, dict) or data.get("@type") != "JobPosting":
            continue
        result["title"] = str(data.get("title") or "").strip()
        org = data.get("hiringOrganization") or {}
        result["company"] = str(org.get("name") or "").strip() if isinstance(org, dict) else ""
        loc = data.get("jobLocation")
        if isinstance(loc, list):
            loc = loc[0] if loc else None
        if isinstance(loc, dict):
            addr = loc.get("address") or {}
            if isinstance(addr, dict):
                city = str(addr.get("addressLocality") or "").strip()
                region = str(addr.get("addressRegion") or "").strip()
                result["location"] = ", ".join(filter(None, [city, region]))
        if result["title"] or result["company"]:
            return result
    # Fallback: LinkedIn guest API HTML fragment selectors
    m = re.search(r'<h2[^>]*top-card-layout__title[^>]*>(.*?)</h2>', html, re.S | re.I)
    if m:
        result["title"] = _strip_html_tags(m.group(1))
    m = re.search(r'<a[^>]*topcard__org-name-link[^>]*>(.*?)</a>', html, re.S | re.I)
    if m:
        result["company"] = _strip_html_tags(m.group(1))
    m = re.search(r'<span[^>]*topcard__flavor--bullet[^>]*>(.*?)</span>', html, re.S | re.I)
    if m:
        result["location"] = _strip_html_tags(m.group(1))
    return result


def _build_custom_job_record(job_id: str, jd_url: str, event: Dict[str, Any], user_id: str) -> Dict[str, Any]:
    payload = _get_json_body(event)
    params = event.get("queryStringParameters") or {}
    if not isinstance(params, dict):
        params = {}
    title = (payload.get("title") or params.get("title") or "").strip()
    company = (payload.get("company") or params.get("company") or "").strip()
    location = (payload.get("location") or params.get("location") or "").strip()
    if not title or not company:
        try:
            li_job_id = extract_linkedin_job_id(jd_url)
            html = fetch_linkedin_guest_html(li_job_id) if li_job_id else fetch_url_text(jd_url)
            scraped = _parse_job_metadata_from_html(html)
            title = title or scraped.get("title") or ""
            company = company or scraped.get("company") or ""
            location = location or scraped.get("location") or ""
        except Exception as exc:
            print(f"[add-url] metadata fetch failed for {jd_url}: {exc}")
    return {
        "jobId": job_id,
        "title": title or "Custom Job",
        "company": company or "(unknown)",
        "location": location,
        "url": jd_url,
        "seenAt": int(time.time()),
        "userIds": [user_id],
    }


def _add_user_membership(table, item: Dict[str, Any], user_id: str) -> Dict[str, Any]:
    job_id = str(item.get("jobId") or "").strip()
    if not job_id:
        return item
    user_ids = item.get("userIds")
    if not isinstance(user_ids, list):
        user_ids = []
    normalized_ids = [str(v).strip() for v in user_ids if str(v).strip()]
    if user_id in normalized_ids:
        return item
    normalized_ids.append(user_id)
    now = int(time.time())
    try:
        table.update_item(
            Key={"jobId": job_id},
            UpdateExpression="SET #userIds = :userIds, #updatedAt = :updatedAt",
            ExpressionAttributeNames={"#userIds": "userIds", "#updatedAt": "updatedAt"},
            ExpressionAttributeValues={":userIds": normalized_ids, ":updatedAt": now},
        )
        latest = table.get_item(Key={"jobId": job_id}).get("Item")
        return latest or {**item, "userIds": normalized_ids}
    except ClientError:
        latest = table.get_item(Key={"jobId": job_id}).get("Item")
        return latest or {**item, "userIds": normalized_ids}


def _build_summary(description: str, resume_tex_path: str, augment: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    jd_found = extract_jd_skills(description) if description else []
    added_skills = []
    added_bullets = []
    if augment:
        added_skills = augment.get("added_skills") or []
        added_bullets = augment.get("added_bullets") or []

    resume_canons: list[str] = []
    try:
        base_resume_path = _select_resume_tex(resume_tex_path, description)
        with open(base_resume_path, "r", encoding="utf-8") as handle:
            base_tex = handle.read()
        resume_canons = canonicalize(extract_resume_skills(base_tex))
    except Exception:
        resume_canons = []

    jd_found_set = set(jd_found)
    resume_set = set(resume_canons)
    added_set = set(added_skills) | set(added_bullets)

    for generic, techs in GENERIC_SKILL_TECH.items():
        if generic not in jd_found_set:
            continue
        concrete_present = False
        for tech in techs:
            if tech in resume_set or tech in added_set or tech in jd_found_set:
                concrete_present = True
                jd_found_set.add(tech)
        if not concrete_present:
            for tech in techs:
                if tech not in resume_set and tech not in jd_found_set:
                    jd_found_set.add(tech)
                    break
        jd_found_set.discard(generic)

    jd_found_set -= set(GENERIC_SKILL_TECH.keys())
    matched_in_resume = sorted(jd_found_set & resume_set)
    not_added = sorted(jd_found_set - resume_set - added_set)

    return {
        "jd_found": sorted(jd_found_set),
        "matched_in_resume": matched_in_resume,
        "not_added": not_added,
    }


def _get_user_asset(item: Dict[str, Any], attr: str, user_id: str) -> Dict[str, Any]:
    per_user = item.get(attr) or {}
    if not isinstance(per_user, dict):
        return {}
    value = per_user.get(user_id)
    if isinstance(value, dict):
        return value
    return {}


def _legacy_asset_visible(
    item: Dict[str, Any],
    user_id: str,
    uploaded_key: str,
    allow_legacy_owner: bool = False,
) -> bool:
    user_ids = item.get("userIds") or []
    if user_id not in user_ids:
        return False
    if allow_legacy_owner:
        return bool(item.get(uploaded_key))
    if len(user_ids) > 1:
        return False
    return bool(item.get(uploaded_key))


def _update_user_asset(table, job_id: str, attr: str, user_id: str, payload: Dict[str, Any]) -> None:
    latest = table.get_item(Key={"jobId": job_id}).get("Item") or {}
    per_user = latest.get(attr) or {}
    if not isinstance(per_user, dict):
        per_user = {}
    per_user[user_id] = payload
    table.update_item(
        Key={"jobId": job_id},
        UpdateExpression="SET #attr = :val, #updatedAt = :updatedAt",
        ExpressionAttributeNames={"#attr": attr, "#updatedAt": "updatedAt"},
        ExpressionAttributeValues={":val": per_user, ":updatedAt": int(time.time())},
    )


def handler(event, _context):
    if _get_method(event) == "OPTIONS":
        return _response(200, {"ok": True})
    access_token = _extract_bearer_token(event)
    is_valid, auth_error, identity = _validate_access_token(access_token)
    if not is_valid:
        return _error_response(401, auth_error)
    user_id = identity.get("userId", "").strip()
    if not user_id:
        return _error_response(401, "Token missing user identity")

    job_id = _get_param(event, "jobId")
    jd_url = _get_param(event, "jdUrl") or _get_param(event, "jd_url")
    path = _get_path(event)
    body_payload = _get_json_body(event)
    if not job_id and jd_url and path.endswith("/generate") and _get_method(event) == "POST":
        job_id = _derive_job_id_from_url(jd_url)
    if not job_id and jd_url and path.endswith("/cover-letter") and _get_method(event) == "POST":
        job_id = _derive_job_id_from_url(jd_url)
    if (
        not job_id
        and not path.endswith("/latest")
        and not path.endswith("/list")
        and not path.endswith("/add-url")
        and not path.endswith("/user/settings")
        and not path.endswith("/user/change-password")
        and not path.endswith("/admin/users")
        and not path.endswith("/admin/user-token")
        and not path.endswith("/admin/test-notification")
        and not path.endswith("/admin/test-run")
        and not path.endswith("/job/update")
    ):
        return _response(400, {"error": "Missing jobId"})

    config = Config()
    table_name = os.getenv("DYNAMODB_TABLE", config.table_name)
    table = boto3.resource("dynamodb").Table(table_name)
    s3 = boto3.client("s3")
    user_profile = _get_or_create_user_profile(table, user_id, config, identity)
    template_user = str(
        user_profile.get("templateUser")
        or user_profile.get("username")
        or identity.get("username")
        or ""
    ).strip()
    if not template_user:
        template_user = config.default_template_user
    template_available = config.apply_template_user(template_user)
    requested_resume_template = (
        _get_param(event, "resumeTemplate")
        or _get_param(event, "resume_template")
        or str(body_payload.get("resumeTemplate") or body_payload.get("resume_template") or "").strip()
    )
    if requested_resume_template:
        if not config.apply_resume_template(requested_resume_template):
            return _error_response(400, f"Unknown resume template: {requested_resume_template}")
    selected_resume_template = os.path.basename(config.resume_tex_path)
    resume_templates = config.list_resume_templates()
    allow_legacy_owner = _can_claim_legacy_jobs(identity)

    if path.endswith("/user/settings"):
        if _get_method(event) == "GET":
            return _response(
                200,
                {
                    "userId": user_id,
                    "username": str(identity.get("username") or "").strip().lower(),
                    "isAdmin": _is_admin(identity),
                    "settings": {
                        "keywords": user_profile.get("keywords", config.keywords),
                        "location": user_profile.get("location", config.location),
                        "enabled": bool(user_profile.get("enabled", True)),
                        "scheduleEnabled": bool(user_profile.get("scheduleEnabled", False)),
                        "scheduleTimezone": str(user_profile.get("scheduleTimezone") or "America/New_York"),
                        "scheduleStart": str(user_profile.get("scheduleStart") or "09:00"),
                        "scheduleEnd": str(user_profile.get("scheduleEnd") or "17:00"),
                        "linkedInUrl": str(user_profile.get("linkedInUrl") or ""),
                        "portfolioUrl": str(user_profile.get("portfolioUrl") or ""),
                        "recruiterMessageTemplate": str(user_profile.get("recruiterMessageTemplate") or ""),
                    },
                },
            )
        if _get_method(event) == "POST":
            payload = _get_json_body(event)
            raw_keywords = payload.get("keywords")
            keywords_list = _normalize_role_keywords(
                raw_keywords,
                str(user_profile.get("keywords") or config.keywords),
            )
            keywords = "\n".join(keywords_list)
            location = str(payload.get("location") or user_profile.get("location") or config.location).strip()
            enabled = _parse_bool(payload.get("enabled"), bool(user_profile.get("enabled", True)))
            schedule_enabled = _parse_bool(payload.get("scheduleEnabled"), bool(user_profile.get("scheduleEnabled", False)))
            schedule_timezone = str(
                payload.get("scheduleTimezone")
                or user_profile.get("scheduleTimezone")
                or "America/New_York"
            ).strip()
            schedule_start = str(payload.get("scheduleStart") or user_profile.get("scheduleStart") or "09:00").strip()
            schedule_end = str(payload.get("scheduleEnd") or user_profile.get("scheduleEnd") or "17:00").strip()
            if schedule_enabled:
                try:
                    ZoneInfo(schedule_timezone)
                except Exception:
                    return _error_response(400, "Invalid schedule timezone")
                duration_mins = _window_duration_minutes(schedule_start, schedule_end)
                if duration_mins is None or duration_mins <= 0:
                    return _error_response(400, "Invalid schedule start/end")
                if duration_mins > 14 * 60:
                    return _error_response(400, "Schedule window cannot exceed 14 hours")
            linked_in_url = str(payload.get("linkedInUrl") or user_profile.get("linkedInUrl") or "").strip()
            portfolio_url = str(payload.get("portfolioUrl") or user_profile.get("portfolioUrl") or "").strip()
            recruiter_message_template = str(payload.get("recruiterMessageTemplate") if payload.get("recruiterMessageTemplate") is not None else (user_profile.get("recruiterMessageTemplate") or ""))
            update_fields = {
                "itemType": "userProfile",
                "userId": user_id,
                "username": str(user_profile.get("username") or identity.get("username") or "").strip().lower(),
                "templateUser": str(user_profile.get("templateUser") or user_profile.get("username") or identity.get("username") or config.default_template_user).strip().lower(),
                "keywords": keywords or config.keywords,
                "location": location or config.location,
                "enabled": enabled,
                "scheduleEnabled": schedule_enabled,
                "scheduleTimezone": schedule_timezone or "America/New_York",
                "scheduleStart": schedule_start or "09:00",
                "scheduleEnd": schedule_end or "17:00",
                "linkedInUrl": linked_in_url,
                "portfolioUrl": portfolio_url,
                "recruiterMessageTemplate": recruiter_message_template,
                "updatedAt": int(time.time()),
            }
            table.update_item(
                Key={"jobId": _user_profile_key(user_id)},
                UpdateExpression="SET " + ", ".join([f"#{k} = :{k}" for k in update_fields.keys()]),
                ExpressionAttributeNames={f"#{k}": k for k in update_fields.keys()},
                ExpressionAttributeValues={f":{k}": v for k, v in update_fields.items()},
            )
            return _response(200, {"ok": True, "settings": update_fields})
        return _error_response(405, "Method not allowed")

    if path.endswith("/user/change-password"):
        if _get_method(event) != "POST":
            return _error_response(405, "Method not allowed")
        payload = _get_json_body(event)
        current_password = str(payload.get("currentPassword") or "")
        new_password = str(payload.get("newPassword") or "")
        if not current_password or not new_password:
            return _error_response(400, "currentPassword and newPassword are required")
        if current_password == new_password:
            return _error_response(400, "New password must be different from current password")
        region = os.getenv("COGNITO_REGION", "").strip()
        if not region:
            return _error_response(500, "Cognito is not configured")
        try:
            cognito = boto3.client("cognito-idp", region_name=region)
            cognito.change_password(
                AccessToken=access_token,
                PreviousPassword=current_password,
                ProposedPassword=new_password,
            )
        except cognito.exceptions.NotAuthorizedException:
            return _error_response(400, "Current password is incorrect")
        except cognito.exceptions.InvalidPasswordException as exc:
            message = exc.response.get("Error", {}).get("Message") if hasattr(exc, "response") else ""
            return _error_response(400, f"Password does not meet policy: {message or exc}")
        except cognito.exceptions.LimitExceededException:
            return _error_response(429, "Too many attempts, please try again later")
        except Exception as exc:
            return _error_response(500, f"Failed to change password: {exc}")
        return _response(200, {"ok": True})

    if path.endswith("/admin/users"):
        if not _is_admin(identity):
            return _error_response(403, "Forbidden")
        if _get_method(event) == "GET":
            profiles = _load_user_profiles(table)
            for profile in profiles:
                profile["displayName"] = str(profile.get("username") or profile.get("templateUser") or profile.get("userId") or "")
                explicit_key = str(profile.get("notificationUserKey") or "").strip()
                fallback_key = config.pushover_user_key if str(profile.get("username") or "").strip().lower() == "umang" else ""
                profile["effectiveNotificationUserKey"] = explicit_key or fallback_key
                profile["notificationUserKeySource"] = "profile" if explicit_key else ("default" if fallback_key else "none")
            return _response(200, {"users": profiles})
        if _get_method(event) == "POST":
            payload = _get_json_body(event)
            username = str(payload.get("username") or "").strip().lower()
            password = str(payload.get("password") or "")
            template_user = str(payload.get("templateUser") or username).strip().lower()
            enabled = _parse_bool(payload.get("enabled"), True)
            if not username or not password:
                return _error_response(400, "username and password are required")
            if len(password) < 8:
                return _error_response(400, "password must be at least 8 characters")
            region = os.getenv("COGNITO_REGION", "").strip()
            user_pool_id = os.getenv("COGNITO_USER_POOL_ID", "").strip()
            if not region or not user_pool_id:
                return _error_response(500, "Cognito is not configured")
            cognito = boto3.client("cognito-idp", region_name=region)
            user_created = False
            user_info: Optional[Dict[str, Any]] = None
            try:
                cognito.admin_create_user(
                    UserPoolId=user_pool_id,
                    Username=username,
                    MessageAction="SUPPRESS",
                )
                user_created = True
                cognito.admin_set_user_password(
                    UserPoolId=user_pool_id,
                    Username=username,
                    Password=password,
                    Permanent=True,
                )
            except cognito.exceptions.UsernameExistsException:
                try:
                    user_info = cognito.admin_get_user(UserPoolId=user_pool_id, Username=username)
                except Exception:
                    return _error_response(409, "User already exists")
                existing_identity = _extract_identity(user_info)
                existing_user_id = str(existing_identity.get("userId") or "").strip() or username
                existing_profile = table.get_item(Key={"jobId": _user_profile_key(existing_user_id)}).get("Item")
                if existing_profile:
                    return _error_response(409, "User already exists")
                try:
                    cognito.admin_set_user_password(
                        UserPoolId=user_pool_id,
                        Username=username,
                        Password=password,
                        Permanent=True,
                    )
                except cognito.exceptions.InvalidPasswordException as exc:
                    message = exc.response.get("Error", {}).get("Message") if hasattr(exc, "response") else ""
                    return _error_response(400, f"Password does not meet policy: {message or exc}")
                except Exception as exc:
                    return _error_response(500, f"Failed to initialize existing user: {exc}")
            except cognito.exceptions.InvalidPasswordException as exc:
                if user_created:
                    try:
                        cognito.admin_delete_user(UserPoolId=user_pool_id, Username=username)
                    except Exception:
                        pass
                message = exc.response.get("Error", {}).get("Message") if hasattr(exc, "response") else ""
                return _error_response(400, f"Password does not meet policy: {message or exc}")
            except Exception as exc:
                if user_created:
                    try:
                        cognito.admin_delete_user(UserPoolId=user_pool_id, Username=username)
                    except Exception:
                        pass
                return _error_response(500, f"Failed to create user: {exc}")
            if not user_info:
                try:
                    user_info = cognito.admin_get_user(UserPoolId=user_pool_id, Username=username)
                except Exception as exc:
                    return _error_response(500, f"User created but failed to fetch profile: {exc}")
            created_identity = _extract_identity(user_info)
            created_user_id = str(created_identity.get("userId") or "").strip() or username
            profile_item = {
                "jobId": _user_profile_key(created_user_id),
                "itemType": "userProfile",
                "userId": created_user_id,
                "username": username,
                "templateUser": template_user or username,
                "keywords": config.keywords,
                "location": config.location,
                "enabled": enabled,
                "updatedAt": int(time.time()),
            }
            table.put_item(Item=profile_item)
            return _response(
                200,
                {
                    "ok": True,
                    "user": {
                        "userId": created_user_id,
                        "username": username,
                        "templateUser": template_user or username,
                        "enabled": enabled,
                    },
                },
            )
        return _error_response(405, "Method not allowed")

    if path.endswith("/admin/user-token"):
        if not _is_admin(identity):
            return _error_response(403, "Forbidden")
        if _get_method(event) != "POST":
            return _error_response(405, "Method not allowed")
        payload = _get_json_body(event)
        identifier = str(payload.get("username") or payload.get("userId") or "").strip().lower()
        token = str(payload.get("notificationUserKey") or "").strip()
        if not identifier:
            return _error_response(400, "username or userId is required")
        profiles = _load_user_profiles(table)
        profile = _find_profile_by_identifier(profiles, identifier)
        if not profile:
            return _error_response(404, "User profile not found")
        table.update_item(
            Key={"jobId": str(profile.get("jobId") or _user_profile_key(str(profile.get("userId") or "")))},
            UpdateExpression="SET #notificationUserKey = :token, #updatedAt = :updatedAt",
            ExpressionAttributeNames={"#notificationUserKey": "notificationUserKey", "#updatedAt": "updatedAt"},
            ExpressionAttributeValues={":token": token, ":updatedAt": int(time.time())},
        )
        return _response(200, {"ok": True, "username": profile.get("username") or "", "userId": profile.get("userId") or "", "notificationUserKeySet": bool(token)})

    if path.endswith("/admin/test-notification"):
        if not _is_admin(identity):
            return _error_response(403, "Forbidden")
        if _get_method(event) != "POST":
            return _error_response(405, "Method not allowed")
        payload = _get_json_body(event)
        identifier = str(payload.get("username") or payload.get("userId") or "").strip().lower()
        message = str(payload.get("message") or "").strip() or "PingedIn test notification"
        if not identifier:
            return _error_response(400, "username or userId is required")
        profiles = _load_user_profiles(table)
        profile = _find_profile_by_identifier(profiles, identifier)
        if not profile:
            return _error_response(404, "User profile not found")
        username = str(profile.get("username") or profile.get("displayName") or profile.get("userId") or "").strip().lower()
        user_key = str(profile.get("notificationUserKey") or "").strip()
        if not user_key:
            return _error_response(400, "notificationUserKey is not configured for this user")
        if not config.pushover_app_token:
            return _error_response(500, "Pushover app token is not configured")
        notifier = PushoverNotifier(user_key=user_key, app_token=config.pushover_app_token)
        ok = notifier.send(
            title=f"PingedIn test for {username}",
            message=message,
            url=os.getenv("PORTAL_URL_BASE", "").strip() or None,
        )
        if not ok:
            return _error_response(500, "Failed to send notification")
        return _response(200, {"ok": True, "username": username})

    if path.endswith("/admin/test-run"):
        if not _is_admin(identity):
            return _error_response(403, "Forbidden")
        if _get_method(event) != "POST":
            return _error_response(405, "Method not allowed")
        payload = _get_json_body(event)
        target_username = str(payload.get("username") or "").strip().lower()
        force_tpr = str(payload.get("force_tpr") or "").strip()
        invoke_payload: Dict[str, Any] = {}
        if force_tpr:
            invoke_payload["force_tpr"] = force_tpr
        if target_username:
            profiles = _load_user_profiles(table)
            profile = _find_profile_by_identifier(profiles, target_username)
            resolved_username = str((profile or {}).get("username") or "").strip().lower()
            if not resolved_username:
                return _error_response(400, "Target user must have a username configured")
            invoke_payload["username"] = resolved_username
        function_name = os.getenv("JOB_CHECKER_FUNCTION_NAME", "").strip()
        if not function_name:
            return _error_response(500, "Job checker function is not configured")
        try:
            lambda_client = boto3.client("lambda")
            invoke_resp = lambda_client.invoke(
                FunctionName=function_name,
                InvocationType="Event",
                Payload=json.dumps(invoke_payload).encode("utf-8"),
            )
        except Exception as exc:
            return _error_response(500, f"Failed to invoke lambda: {exc}")
        return _response(
            200,
            {
                "ok": True,
                "invoked": True,
                "statusCode": int(invoke_resp.get("StatusCode") or 0),
                "payload": invoke_payload,
            },
        )

    if path.endswith("/add-url"):
        if _get_method(event) != "POST":
            return _error_response(405, "Method not allowed")
        payload = _get_json_body(event)
        add_jd_url = _normalize_job_url(
            payload.get("jdUrl")
            or payload.get("jd_url")
            or _get_param(event, "jdUrl")
            or _get_param(event, "jd_url")
            or ""
        )
        if not add_jd_url:
            return _error_response(400, "Invalid or missing jdUrl")
        add_job_id = str(payload.get("jobId") or _get_param(event, "jobId") or "").strip()
        if not add_job_id:
            add_job_id = _derive_job_id_from_url(add_jd_url)
        if not add_job_id:
            return _error_response(400, "Unable to derive jobId from URL")

        existing = table.get_item(Key={"jobId": add_job_id}).get("Item")
        if existing:
            item = _add_user_membership(table, existing, user_id)
            if not str(item.get("url") or "").strip():
                now = int(time.time())
                table.update_item(
                    Key={"jobId": add_job_id},
                    UpdateExpression="SET #url = :url, #updatedAt = :updatedAt",
                    ExpressionAttributeNames={"#url": "url", "#updatedAt": "updatedAt"},
                    ExpressionAttributeValues={":url": add_jd_url, ":updatedAt": now},
                )
                item = table.get_item(Key={"jobId": add_job_id}).get("Item") or item
        else:
            item = _build_custom_job_record(add_job_id, add_jd_url, event, user_id)
            table.put_item(Item=item)
        return _response(
            200,
            {
                "ok": True,
                "jobId": add_job_id,
                "job": item,
            },
        )

    item = None
    if path.endswith("/list") and not job_id:
        page = 1
        page_size = 10
        search_query = str(_get_param(event, "q") or "").strip().lower()
        try:
            page = int(_get_param(event, "page") or page)
        except Exception:
            page = 1
        try:
            page_size = int(_get_param(event, "pageSize") or _get_param(event, "limit") or page_size)
        except Exception:
            page_size = 10
        page = max(1, page)
        page_size = max(1, min(page_size, 100))

        scan_kwargs = {
            "ProjectionExpression": (
                "jobId, seenAt, #t, #c, #l, #u, compensation, "
                "resumePdfUploaded, summaryPdfUploaded, coverLetterPdfUploaded, "
                "resumeGeneratedAt, coverLetterGeneratedAt, userIds, resumeByUser, coverLetterByUser"
            ),
            "ExpressionAttributeNames": {"#t": "title", "#c": "company", "#l": "location", "#u": "url"},
        }
        items = []
        resp = table.scan(**scan_kwargs)
        items.extend(resp.get("Items") or [])
        while resp.get("LastEvaluatedKey"):
            resp = table.scan(ExclusiveStartKey=resp["LastEvaluatedKey"], **scan_kwargs)
            items.extend(resp.get("Items") or [])

        filtered_items = []
        for it in items:
            if str(it.get("jobId", "")).startswith("__"):
                continue
            user_ids = it.get("userIds") or []
            if user_id in user_ids:
                filtered_items.append(it)
                continue
            if not user_ids and _can_claim_legacy_jobs(identity):
                claimed = _claim_legacy_job(table, it, user_id)
                if user_id in (claimed.get("userIds") or []):
                    filtered_items.append(claimed)
        items = filtered_items
        for it in items:
            resume_asset = _get_user_asset(it, "resumeByUser", user_id)
            cover_asset = _get_user_asset(it, "coverLetterByUser", user_id)
            it["resumePdfUploaded"] = bool(
                resume_asset.get("resumePdfUploaded")
                or _legacy_asset_visible(it, user_id, "resumePdfUploaded", allow_legacy_owner)
            )
            it["coverLetterPdfUploaded"] = bool(
                cover_asset.get("coverLetterPdfUploaded")
                or _legacy_asset_visible(it, user_id, "coverLetterPdfUploaded", allow_legacy_owner)
            )
            it["resumeGeneratedAt"] = int(resume_asset.get("resumeGeneratedAt") or it.get("resumeGeneratedAt") or 0)
            it["coverLetterGeneratedAt"] = int(cover_asset.get("coverLetterGeneratedAt") or it.get("coverLetterGeneratedAt") or 0)

        if search_query:
            def _matches_search(job_item: Dict[str, Any]) -> bool:
                haystack = " ".join(
                    [
                        str(job_item.get("jobId") or ""),
                        str(job_item.get("title") or ""),
                        str(job_item.get("company") or ""),
                        str(job_item.get("location") or ""),
                        str(job_item.get("compensation") or ""),
                    ]
                ).lower()
                return search_query in haystack

            items = [it for it in items if _matches_search(it)]

        items.sort(key=lambda it: it.get("seenAt", 0), reverse=True)
        total_count = len(items)
        total_pages = max(1, (total_count + page_size - 1) // page_size)
        if page > total_pages:
            page = total_pages
        start_idx = (page - 1) * page_size
        paged_items = items[start_idx: start_idx + page_size]
        return _response(
            200,
            {
                "items": paged_items,
                "totalCount": total_count,
                "page": page,
                "pageSize": page_size,
                "totalPages": total_pages,
            },
        )
    if path.endswith("/latest") and not job_id:
        resp = table.scan(
            ProjectionExpression="jobId, seenAt, #t, #c, #l, #u, resumeS3Key, resumeUrl, resumeJobDescriptionKey, resumeAugmentResultKey, userIds",
            ExpressionAttributeNames={"#t": "title", "#c": "company", "#l": "location", "#u": "url"},
        )
        items = resp.get("Items") or []
        filtered_items = []
        for it in items:
            user_ids = it.get("userIds") or []
            if user_id in user_ids:
                filtered_items.append(it)
                continue
            if not user_ids and _can_claim_legacy_jobs(identity):
                claimed = _claim_legacy_job(table, it, user_id)
                if user_id in (claimed.get("userIds") or []):
                    filtered_items.append(claimed)
        items = filtered_items
        if items:
            item = max(items, key=lambda it: it.get("seenAt", 0))
            job_id = item.get("jobId")
    if not item and job_id:
        resp = table.get_item(Key={"jobId": job_id})
        item = resp.get("Item")
    if not item and jd_url and path.endswith("/generate") and _get_method(event) == "POST":
        item = _build_custom_job_record(job_id, jd_url, event, user_id)
        table.put_item(Item=item)
    if not item and jd_url and path.endswith("/cover-letter") and _get_method(event) == "POST":
        item = _build_custom_job_record(job_id, jd_url, event, user_id)
        table.put_item(Item=item)
    if not item:
        return _response(404, {"error": "Job not found"})
    if user_id not in (item.get("userIds") or []):
        if not (item.get("userIds") or []) and _can_claim_legacy_jobs(identity):
            item = _claim_legacy_job(table, item, user_id)
    if user_id not in (item.get("userIds") or []):
        return _response(404, {"error": "Job not found"})

    if path.endswith("/job/update") and _get_method(event) == "POST":
        allowed_fields = {"company", "title"}
        updates = {k: v for k, v in (body_payload or {}).items() if k in allowed_fields and isinstance(v, str)}
        if not updates:
            return _response(400, {"error": "No valid fields to update"})
        expr_names = {f"#f{i}": k for i, k in enumerate(updates)}
        expr_values = {f":v{i}": v for i, v in enumerate(updates.values())}
        set_parts = [f"{n} = {v}" for n, v in zip(expr_names.keys(), expr_values.keys())]
        table.update_item(
            Key={"jobId": job_id},
            UpdateExpression="SET " + ", ".join(set_parts),
            ExpressionAttributeNames=expr_names,
            ExpressionAttributeValues=expr_values,
        )
        return _response(200, {"ok": True, **updates})

    bucket = config.resume_s3_bucket
    prefix = config.resume_s3_prefix
    store = ResumeStore(bucket=bucket, prefix=prefix, url_expires_seconds=config.resume_url_expires_seconds)

    jd_key = item.get("resumeJobDescriptionKey")
    if not jd_key:
        jd_key = store.key_for(job_id, "job_description.txt")
    description = ""
    try:
        description = _load_s3_text(s3, bucket, jd_key)
    except Exception:
        description = ""

    augment = None
    augment_key = item.get("resumeAugmentResultKey")
    if augment_key:
        try:
            augment = json.loads(_load_s3_text(s3, bucket, augment_key))
        except Exception:
            augment = None

    resume_url = ""
    resume_asset = _get_user_asset(item, "resumeByUser", user_id)
    resume_uploaded = bool(resume_asset.get("resumePdfUploaded"))
    resume_key = resume_asset.get("resumeS3Key")
    if not resume_uploaded and _legacy_asset_visible(item, user_id, "resumePdfUploaded", allow_legacy_owner):
        resume_uploaded = bool(item.get("resumePdfUploaded"))
        resume_key = item.get("resumeS3Key")
    if resume_uploaded and resume_key:
        try:
            resume_url = store.presigned_url(resume_key)
        except Exception:
            resume_url = ""

    cover_letter_url = ""
    cover_letter_text = ""
    cover_asset = _get_user_asset(item, "coverLetterByUser", user_id)
    cover_letter_uploaded = bool(cover_asset.get("coverLetterPdfUploaded"))
    cover_letter_key = cover_asset.get("coverLetterS3Key")
    cover_letter_tex_key = cover_asset.get("coverLetterTexS3Key")
    if not cover_letter_uploaded and _legacy_asset_visible(item, user_id, "coverLetterPdfUploaded", allow_legacy_owner):
        cover_letter_uploaded = bool(item.get("coverLetterPdfUploaded"))
        cover_letter_key = item.get("coverLetterS3Key")
        cover_letter_tex_key = cover_letter_tex_key or item.get("coverLetterTexS3Key")
    if cover_letter_uploaded and cover_letter_key:
        try:
            cover_letter_url = store.presigned_url(cover_letter_key)
        except Exception:
            cover_letter_url = ""
    if cover_letter_tex_key and bucket:
        try:
            tex = _load_s3_text(s3, bucket, cover_letter_tex_key)
            cover_letter_text = _tex_to_plain_text(tex)
        except Exception:
            cover_letter_text = ""

    if path.endswith("/generate") and _get_method(event) == "POST":
        if not template_available:
            return _response(400, {"error": "Resume template is not configured for this user"})
        if not description:
            try:
                if jd_url:
                    description = _fetch_description_from_url(jd_url, config.jd_fetch_mode)
                if not description:
                    client = LinkedInGuestClient(config)
                    description = fetch_job_description(
                        client,
                        item.get("url", ""),
                        job_id,
                        config.jd_fetch_mode,
                    )
            except Exception:
                description = ""
        if not description:
            return _response(400, {"error": "Missing job description"})
        try:
            assets = generate_resume_assets(config, store, item, description)
            resume_url = ""
            if assets.get("pdf_uploaded") and assets.get("pdf_key"):
                try:
                    resume_url = store.presigned_url(assets["pdf_key"])
                except Exception:
                    resume_url = ""
            update_fields = {
                "resumeS3Bucket": config.resume_s3_bucket,
                "resumeS3Key": assets.get("pdf_key", ""),
                "resumePdfFilename": assets.get("pdf_filename", ""),
                "resumeGeneratedAt": assets.get("generated_at", 0),
                "resumeTemplate": selected_resume_template,
                "resumeTexS3Key": assets.get("tex_key", ""),
                "resumeUrl": assets.get("pdf_url", ""),
                "resumePdfUploaded": assets.get("pdf_uploaded", False),
                "summaryS3Key": assets.get("summary_pdf_key", ""),
                "summaryPdfUploaded": assets.get("summary_pdf_uploaded", False),
                "resumeAugmentResultKey": assets.get("augment_result_key", ""),
                "resumeSkillsKey": assets.get("resume_skills_key", ""),
                "resumeJobDescriptionKey": assets.get("jd_key", jd_key),
                "resumeJobRecordKey": assets.get("job_record_key", ""),
            }
            _update_user_asset(
                table,
                job_id,
                "resumeByUser",
                user_id,
                {
                    "resumeS3Bucket": config.resume_s3_bucket,
                    "resumeS3Key": assets.get("pdf_key", ""),
                    "resumePdfFilename": assets.get("pdf_filename", ""),
                    "resumeGeneratedAt": assets.get("generated_at", 0),
                    "resumeTemplate": selected_resume_template,
                    "resumeTexS3Key": assets.get("tex_key", ""),
                    "resumeUrl": assets.get("pdf_url", ""),
                    "resumePdfUploaded": assets.get("pdf_uploaded", False),
                    "summaryS3Key": assets.get("summary_pdf_key", ""),
                    "summaryPdfUploaded": assets.get("summary_pdf_uploaded", False),
                    "resumeAugmentResultKey": assets.get("augment_result_key", ""),
                    "resumeSkillsKey": assets.get("resume_skills_key", ""),
                    "resumeJobDescriptionKey": assets.get("jd_key", jd_key),
                    "resumeJobRecordKey": assets.get("job_record_key", ""),
                },
            )
            table.update_item(
                Key={"jobId": job_id},
                UpdateExpression="SET " + ", ".join([f"#{k} = :{k}" for k in update_fields.keys()]),
                ExpressionAttributeNames={f"#{k}": k for k in update_fields.keys()},
                ExpressionAttributeValues={f":{k}": v for k, v in update_fields.items()},
            )
            return _response(
                200,
                {
                    "ok": True,
                    "resumeUrl": resume_url,
                    "resumeGeneratedAt": assets.get("generated_at", 0),
                },
            )
        except Exception as exc:
            return _response(500, {"error": str(exc)})

    if path.endswith("/cover-letter") and _get_method(event) == "POST":
        if not template_available:
            return _response(400, {"error": "Cover letter template is not configured for this user"})
        if not description:
            try:
                if jd_url:
                    description = _fetch_description_from_url(jd_url, config.jd_fetch_mode)
                if not description:
                    client = LinkedInGuestClient(config)
                    description = fetch_job_description(
                        client,
                        item.get("url", ""),
                        job_id,
                        config.jd_fetch_mode,
                    )
            except Exception:
                description = ""
        try:
            assets = generate_cover_letter_assets(
                config,
                store,
                item,
                description,
                manual_triggered=True,
            )
            cover_letter_url = ""
            if assets.get("cover_letter_pdf_uploaded") and assets.get("cover_letter_pdf_key"):
                try:
                    cover_letter_url = store.presigned_url(assets["cover_letter_pdf_key"])
                except Exception:
                    cover_letter_url = ""
            update_fields = {
                "coverLetterS3Bucket": config.resume_s3_bucket,
                "coverLetterS3Key": assets.get("cover_letter_pdf_key", ""),
                "coverLetterPdfFilename": assets.get("cover_letter_pdf_filename", ""),
                "coverLetterGeneratedAt": assets.get("cover_letter_generated_at", 0),
                "coverLetterTexS3Key": assets.get("cover_letter_tex_key", ""),
                "coverLetterUrl": assets.get("cover_letter_pdf_url", ""),
                "coverLetterPdfUploaded": assets.get("cover_letter_pdf_uploaded", False),
                "organizationMission": assets.get("organization_mission", ""),
            }
            _update_user_asset(
                table,
                job_id,
                "coverLetterByUser",
                user_id,
                {
                    "coverLetterS3Bucket": config.resume_s3_bucket,
                    "coverLetterS3Key": assets.get("cover_letter_pdf_key", ""),
                    "coverLetterPdfFilename": assets.get("cover_letter_pdf_filename", ""),
                    "coverLetterGeneratedAt": assets.get("cover_letter_generated_at", 0),
                    "coverLetterTexS3Key": assets.get("cover_letter_tex_key", ""),
                    "coverLetterUrl": assets.get("cover_letter_pdf_url", ""),
                    "coverLetterPdfUploaded": assets.get("cover_letter_pdf_uploaded", False),
                    "organizationMission": assets.get("organization_mission", ""),
                },
            )
            table.update_item(
                Key={"jobId": job_id},
                UpdateExpression="SET " + ", ".join([f"#{k} = :{k}" for k in update_fields.keys()]),
                ExpressionAttributeNames={f"#{k}": k for k in update_fields.keys()},
                ExpressionAttributeValues={f":{k}": v for k, v in update_fields.items()},
            )
            return _response(
                200,
                {
                    "ok": True,
                    "coverLetterUrl": cover_letter_url,
                    "coverLetterGeneratedAt": assets.get("cover_letter_generated_at", 0),
                    "organizationMission": assets.get("organization_mission", ""),
                },
            )
        except Exception as exc:
            return _response(500, {"error": str(exc)})

    summary = _build_summary(description, config.resume_tex_path, augment)
    organization_mission = str(
        cover_asset.get("organizationMission")
        or item.get("organizationMission")
        or ""
    )
    return _response(
        200,
        {
            "job": item,
            "description": description,
            "augment": augment,
            "resumeUrl": resume_url,
            "resumeGeneratedAt": int(resume_asset.get("resumeGeneratedAt") or item.get("resumeGeneratedAt", 0)),
            "selectedResumeTemplate": str(resume_asset.get("resumeTemplate") or selected_resume_template),
            "resumeTemplates": resume_templates,
            "coverLetterUrl": cover_letter_url,
            "coverLetterText": cover_letter_text,
            "coverLetterGeneratedAt": int(cover_asset.get("coverLetterGeneratedAt") or item.get("coverLetterGeneratedAt", 0)),
            "organizationMission": organization_mission,
            "resumeExistsForUser": bool(resume_url),
            "coverLetterExistsForUser": bool(cover_letter_url),
            "templateAvailable": bool(template_available),
            "summary": summary,
            "linkedInUrl": str(user_profile.get("linkedInUrl") or ""),
            "portfolioUrl": str(user_profile.get("portfolioUrl") or ""),
            "recruiterMessageTemplate": str(user_profile.get("recruiterMessageTemplate") or ""),
        },
    )
