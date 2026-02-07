import os
import time
import re
import json
from typing import Dict, List, Optional

import boto3
import urllib.parse
import urllib.request
from html.parser import HTMLParser

from botocore.exceptions import ClientError


DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/120.0.0.0 Safari/537.36"
)


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

        if not self.pushover_app_token and self.pushover_app_token_secret_arn:
            self.pushover_app_token = self._load_secret_token(
                self.pushover_app_token_secret_arn
            )

    @staticmethod
    def _parse_keywords(value: str) -> List[str]:
        return [kw.strip().lower() for kw in value.split(",") if kw.strip()]

    @staticmethod
    def _load_secret_token(secret_arn: str) -> Optional[str]:
        client = boto3.client("secretsmanager")
        response = client.get_secret_value(SecretId=secret_arn)
        token = response.get("SecretString")
        if token:
            return token.strip()
        return None


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

    def fetch_search_page(self, start: int) -> str:
        params = {
            "keywords": self.config.keywords,
            "location": self.config.location,
            "f_TPR": self.config.time_posted,
            "start": start,
        }
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
    ) -> None:
        payload = {
            "token": self.app_token,
            "user": self.user_key,
            "title": title,
            "message": message,
            "html": "1",
        }
        if url:
            payload["url"] = url
            payload["url_title"] = "Open Job"
        data = urllib.parse.urlencode(payload).encode("utf-8")
        req = urllib.request.Request(self.API_URL, data=data, method="POST")
        with urllib.request.urlopen(req, timeout=15) as resp:
            if resp.status >= 400:
                raise RuntimeError(f"Pushover request failed with status {resp.status}")


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
    return "\n".join([line for line in lines if line.split(':', 1)[-1].strip()])


def run(config: Config, table, notifier: Optional[PushoverNotifier]) -> Dict[str, int]:
    client = LinkedInGuestClient(config)
    store = JobStore(table)

    stats = {"fetched": 0, "new": 0, "notified": 0}
    if config.force_tpr:
        client.config.time_posted = config.force_tpr
        print(f"Using forced f_TPR={client.config.time_posted}")
    else:
        last_success = store.get_last_success(config.meta_key, config.last_success_attr)
        if last_success:
            delta = max(1, int(time.time()) - last_success)
            delta = min(delta, config.max_tpr_seconds)
            client.config.time_posted = f"r{delta}"
            print(f"Using dynamic f_TPR={client.config.time_posted} based on lastSuccessEpoch")
        else:
            print(f"Using configured f_TPR={client.config.time_posted} (no lastSuccessEpoch)")
    start = 0

    for _page in range(config.max_pages):
        html = client.fetch_search_page(start)
        cards = parse_job_cards(html)
        print(f"Parsed {len(cards)} job cards on start={start}")
        if not cards:
            break

        for card in cards:
            stats["fetched"] += 1
            job_id = card["jobId"]
            if store.seen(job_id):
                continue

            detail_html = client.fetch_job_detail(job_id)
            description = extract_description(detail_html)
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

            if store.save(job_record):
                stats["new"] += 1
                if notifier:
                    title = f"{job_record['title']} @ {job_record['company']}"
                    notifier.send(
                        title=title,
                        message=format_message(job_record),
                        url=job_record["url"],
                    )
                    stats["notified"] += 1
            time.sleep(config.request_delay)

        if len(cards) < config.page_size:
            break
        start += config.page_size
        time.sleep(config.request_delay)

    if notifier and stats["new"] == 0:
        summary = (
            f"<b>No new jobs found</b>\n"
            f"<b>Keywords:</b> {config.keywords}\n"
            f"<b>Location:</b> {config.location}\n"
            f"<b>Window:</b> {client.config.time_posted}"
        )
        notifier.send(title="LinkedIn Jobs Update", message=summary)

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
