#!/usr/bin/env python3
import argparse
import json
import os
import re
import subprocess
import shutil
import urllib.request
from typing import Dict, List, Tuple

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

DEFAULT_SKILLS_GROUPED = os.path.join(SCRIPT_DIR, 'users', 'umang', 'skills_grouped.json')
DEFAULT_RESUME_TEX = os.path.join(SCRIPT_DIR, 'users', 'umang', 'resume.tex')
DEFAULT_RESUME_SKILLS = os.path.join(SCRIPT_DIR, 'resume_skills.json')
DEFAULT_UPDATED_TEX = os.path.join(SCRIPT_DIR, 'resume_updated.tex')
DEFAULT_UPDATED_PDF = os.path.join(SCRIPT_DIR, 'resume_updated.pdf')
DEFAULT_REPLACEMENT_RULES = os.path.join(SCRIPT_DIR, 'users', 'umang', 'replacement_rules.json')

DEFAULT_USER_AGENT = (
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
    'AppleWebKit/537.36 (KHTML, like Gecko) '
    'Chrome/121.0.0.0 Safari/537.36'
)

SKILL_PATTERNS = {
    'python': r'\bpython\b',
    'sql': r'\bsql\b',
    'spark': r'\bspark\b',
    'airflow': r'\bairflow\b',
    'kafka': r'\bkafka\b',
    'dbt': r'\bdbt\b',
    'snowflake': r'\bsnowflake\b',
    'redshift': r'\bredshift\b',
    'bigquery': r'\bbigquery\b',
    'databricks': r'\bdatabricks\b',
    'hadoop': r'\bhadoop\b',
    'hive': r'\bhive\b',
    'scala': r'\bscala\b',
    'java': r'\bjava\b',
    'aws': r'\baws\b|amazon web services',
    'gcp': r'\bgcp\b|google cloud',
    'azure': r'\bazure\b',
    'docker': r'\bdocker\b',
    'kubernetes': r'\bkubernetes\b|\bk8s\b',
    'terraform': r'\bterraform\b',
    'db modeling': r'data modeling|schema design',
    'etl/elt': r'\betl\b|\belt\b',
    'data warehouse': r'data warehouse|warehousing',
    'streaming': r'streaming|real[- ]time',
    'cdc': r'change data capture|\bcdc\b',
    'postgresql': r'\bpostgresql\b',
    'mongodb': r'\bmongodb\b',
    'redis': r'\bredis\b',
    'pubsub': r'pub/sub|pubsub|pub-sub',
    'cloud composer': r'cloud composer',
    'athena': r'\bathena\b',
    'cassandra': r'\bcassandra\b',
    'clickhouse': r'\bclickhouse\b',
    'dagster': r'\bdagster\b',
    'data factory': r'\bdata factory\b|\badf\b',
    'datadog': r'\bdatadog\b',
    'delta lake': r'\bdelta lake\b|\bdelta\s+lake\b',
    'dynamodb': r'\bdynamodb\b',
    'emr': r'\bemr\b|elastic mapreduce',
    'fivetran': r'\bfivetran\b',
    'flink': r'\bflink\b',
    'glue': r'\baws glue\b|\bglue\b',
    'grafana': r'\bgrafana\b',
    'iceberg': r'\biceberg\b',
    'informatica': r'\binformatica\b',
    'javascript': r'\bjavascript\b',
    'kinesis': r'\bkinesis\b',
    'looker': r'\blooker\b',
    'luigi': r'\bluigi\b',
    'matillion': r'\bmatillion\b',
    'mysql': r'\bmysql\b',
    'oracle': r'\boracle\b',
    'power bi': r'\bpower\s+bi\b',
    'prefect': r'\bprefect\b',
    'presto': r'\bpresto\b',
    'prometheus': r'\bprometheus\b',
    'quicksight': r'\bquicksight\b',
    'sql server': r'\bsql server\b|\bmssql\b',
    'synapse': r'\bsynapse\b|azure synapse',
    'tableau': r'\btableau\b',
    'teradata': r'\bteradata\b',
    'typescript': r'\btypescript\b',
}

# Map canonical skills to resume categories
CATEGORY_MAP = {
    'data engineering': [
        'spark', 'kafka', 'pubsub', 'hive', 'hadoop', 'snowflake', 'bigquery', 'redshift', 'etl/elt',
        'postgresql', 'mongodb', 'redis', 'dbt', 'data warehouse', 'db modeling',
        'athena', 'cassandra', 'clickhouse', 'data factory', 'delta lake',
        'dynamodb', 'emr', 'fivetran', 'flink', 'glue', 'iceberg',
        'informatica', 'kinesis', 'luigi', 'matillion', 'mysql', 'oracle',
        'presto', 'sql server', 'synapse', 'teradata', 'airflow', 'cloud composer',
        'databricks', 'streaming', 'cdc', 'dagster', 'prefect'
    ],
    'cloud & devops': ['aws', 'azure', 'gcp', 'kubernetes', 'docker', 'terraform', 'datadog', 'grafana', 'prometheus'],
    'analytics & ml': ['tableau', 'power bi', 'looker', 'quicksight'],
    'web & backend': [],
    'programming & version control': ['python', 'sql', 'java', 'scala', 'javascript', 'typescript'],
}

# Sub-skill aliases that can be considered reasonable if the parent exists in resume
PARENT_ALIASES = {
    'aws': ['s3', 'lambda', 'cloudfront', 'cognito', 'amplify', 'api gateway', 'step functions', 'rekognition'],
}

# Prefer specific technologies over generic skills when only generic appears in JD.
GENERIC_SKILL_TECH = {
    'data warehouse': ['snowflake', 'redshift', 'bigquery'],
    'streaming': ['kafka', 'spark', 'pubsub'],
    'etl/elt': ['spark', 'airflow'],
    'db modeling': ['postgresql', 'snowflake'],
}


def fetch_url_text(url: str) -> str:
    req = urllib.request.Request(url, headers={'User-Agent': DEFAULT_USER_AGENT})
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = resp.read()
    # Best-effort decode
    return data.decode('utf-8', errors='ignore')


def extract_linkedin_job_id(url: str) -> str:
    m = re.search(r'linkedin\\.com/jobs/view/(\\d+)', url)
    if m:
        return m.group(1)
    m = re.search(r'linkedin\\.com/jobs/view/.*-(\\d+)/?$', url)
    if m:
        return m.group(1)
    return ''


def fetch_linkedin_guest_html(job_id: str) -> str:
    guest_url = f'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/{job_id}'
    return fetch_url_text(guest_url)


def extract_description_from_html(html: str) -> str:
    # Prefer JSON-LD description if present
    m = re.findall(r'<script[^>]*type=\"application/ld\\+json\"[^>]*>(.*?)</script>', html, re.S | re.I)
    for block in m:
        block = block.strip()
        if not block:
            continue
        try:
            data = json.loads(block)
        except Exception:
            continue
        if isinstance(data, list):
            for d in data:
                if isinstance(d, dict) and d.get('description'):
                    return d.get('description')
        if isinstance(data, dict) and data.get('description'):
            return data.get('description')
    # LinkedIn guest job pages often store description in show-more-less-html__markup
    m = re.search(r'show-more-less-html__markup[^>]*>(.*?)</div>', html, re.S | re.I)
    if m:
        snippet = m.group(1)
        snippet = re.sub(r'<[^>]+>', ' ', snippet)
        snippet = re.sub(r'\\s+', ' ', snippet).strip()
        if snippet:
            return snippet
    # Fallback: strip tags and return body text
    text = re.sub(r'<[^>]+>', ' ', html)
    text = re.sub(r'\\s+', ' ', text).strip()
    return text


def extract_description(page_text: str) -> str:
    # If this is already plain text, try to isolate "About the job"
    t = page_text.replace('\r', '')
    m = re.search(r'About the job\\n(.*)', t, re.S)
    if not m:
        return t.strip()
    tail = m.group(1)
    end_markers = [
        '\\nFeatured benefits', '\\nSet alert for similar jobs', '\\nApplicants for this job',
        '\\nAbout the company', '\\nMore jobs', '\\nLooking for talent?', '\\nQuestions?'
    ]
    end = len(tail)
    for marker in end_markers:
        idx = tail.find(marker)
        if idx != -1 and idx < end:
            end = idx
    desc = tail[:end].strip()
    desc = re.sub(r'\\n{2,}', '\\n', desc).strip()
    return desc


def extract_resume_skills(tex: str) -> List[str]:
    m = re.search(r'\\SectionHeading\{SKILLS\}(.*?)(?:\\SectionHeading\{|\\end\{document\})', tex, re.S)
    section = m.group(1) if m else tex
    items = re.findall(r'\\textbf\{([^}]+)\}:\s*([^\\]+)', section)
    raw = []
    for _cat, skills in items:
        s = skills.replace('\\&', '&').replace('\n', ' ')
        parts = [p.strip() for p in s.split(',') if p.strip()]
        raw.extend(parts)
    return sorted(set(raw))


def canonicalize(skills: List[str]) -> List[str]:
    out = set()
    for s in skills:
        sl = s.lower()
        for canon, pattern in SKILL_PATTERNS.items():
            if re.search(pattern, sl, re.I):
                out.add(canon)
    return sorted(out)


def jd_skills(desc: str) -> List[str]:
    found = []
    for canon, pattern in SKILL_PATTERNS.items():
        if re.search(pattern, desc, re.I):
            found.append(canon)
    return sorted(set(found))


def load_group_defs(path: str) -> Dict[str, List[str]]:
    with open(path) as f:
        data = json.load(f)
    return data.get('group_definitions', {})


def load_replacement_rules(path: str) -> Dict[str, Dict[str, object]]:
    if not path or not os.path.exists(path):
        return {'cloud_provider': {}, 'tech_replacements': {}}
    with open(path) as f:
        data = json.load(f)
    return {
        'cloud_provider': data.get('cloud_provider', {}),
        'tech_replacements': data.get('tech_replacements', {}),
    }


def group_for_skill(group_defs: Dict[str, List[str]], canon: str) -> List[str]:
    groups = []
    for g, members in group_defs.items():
        if canon in members:
            groups.append(g)
    return groups


def skill_reasonable(canon: str, resume_canons: List[str], group_defs: Dict[str, List[str]]) -> bool:
    # Reasonable if in a group that already appears in resume skills
    resume_groups = set()
    for s in resume_canons:
        for g in group_for_skill(group_defs, s):
            resume_groups.add(g)
    for g in group_for_skill(group_defs, canon):
        if g in resume_groups:
            return True
    # Related group fallbacks
    related = {
        'data_warehouse_concept': ['data_warehouse_platform'],
        'streaming_concept': ['stream_processing'],
    }
    for g in group_for_skill(group_defs, canon):
        for rel in related.get(g, []):
            if rel in resume_groups:
                return True
    # Reasonable if it is a sub-skill of a parent present in resume
    for parent, aliases in PARENT_ALIASES.items():
        if canon == parent:
            continue
        if canon not in resume_canons:
            if parent in resume_canons and canon in aliases:
                return True
    return False


def update_skills_section(tex: str, missing: List[str], rules: Dict[str, Dict[str, object]]) -> Tuple[str, List[str]]:
    # Map canonical missing skills to display names
    display = {
        'python': 'Python',
        'sql': 'SQL',
        'spark': 'Spark',
        'airflow': 'Airflow',
        'kafka': 'Kafka',
        'dbt': 'dbt',
        'snowflake': 'Snowflake',
        'redshift': 'Redshift',
        'bigquery': 'BigQuery',
        'databricks': 'Databricks',
        'hadoop': 'Hadoop',
        'hive': 'Hive',
        'scala': 'Scala',
        'java': 'Java',
        'aws': 'AWS',
        'gcp': 'GCP',
        'azure': 'Azure',
        'docker': 'Docker',
        'kubernetes': 'Kubernetes',
        'terraform': 'Terraform',
        'db modeling': 'Data Modeling',
        'etl/elt': 'ETL',
        'data warehouse': 'Data Warehouse',
        'streaming': 'Streaming',
        'cdc': 'CDC',
        'postgresql': 'PostgreSQL',
        'mongodb': 'MongoDB',
        'redis': 'Redis',
        'pubsub': 'Pub/Sub',
        'cloud composer': 'Cloud Composer',
    }

    m = re.search(r'(\\SectionHeading\{SKILLS\}.*?\\SkillListStart)(.*?)(\\BulletListEnd)', tex, re.S)
    if not m:
        return tex, []
    prefix, body, suffix = m.group(1), m.group(2), m.group(3)

    lines = body.split('\n')
    updated = []
    added = []

    # Build a map of category line indices
    cat_indices = {}
    for i, line in enumerate(lines):
        cat_match = re.search(r'\\textbf\{([^}]+)\}:', line)
        if cat_match:
            cat = cat_match.group(1).strip().lower()
            cat_indices[cat] = i

    tech_replacements = rules.get('tech_replacements', {})
    cloud_replacements = rules.get('cloud_provider', {})

    for canon in missing:
        disp = display.get(canon, canon)
        # Replace older tech with target in skills line when applicable
        replaced = False
        if canon in tech_replacements or canon in cloud_replacements:
            repl = []
            tech_rule = tech_replacements.get(canon) or {}
            repl.extend(tech_rule.get('skills_replace', []))
            cloud_rule = cloud_replacements.get(canon) or {}
            repl.extend(cloud_rule.get('replace_providers', []))
            for old in repl:
                old_disp = display.get(old, old)
                for i, line in enumerate(lines):
                    if re.search(r'\\b' + re.escape(old_disp) + r'\\b', line):
                        lines[i] = re.sub(
                            r'\\b' + re.escape(old_disp) + r'\\b',
                            disp,
                            line,
                        )
                        replaced = True
            if replaced:
                added.append(disp)
                continue
        # pick category based on CATEGORY_MAP
        chosen_cat = None
        for cat, members in CATEGORY_MAP.items():
            if canon in members:
                chosen_cat = cat
                break
        if not chosen_cat:
            continue
        idx = cat_indices.get(chosen_cat)
        if idx is None:
            continue
        if disp in lines[idx]:
            continue
        # insert before end of line
        line = lines[idx]
        if line.rstrip().endswith('}}'):
            line = line.rstrip()[:-2]
        if line.strip().endswith(':'):
            line = line + ' ' + disp
        else:
            line = line + ', ' + disp
        lines[idx] = line + '}}'
        added.append(disp)

    new_body = '\n'.join(lines)
    new_tex = tex.replace(prefix + body + suffix, prefix + new_body + suffix)
    return new_tex, added


def extract_bullet_items(tex: str) -> List[Tuple[int, int, str]]:
    items = []
    i = 0
    while True:
        start = tex.find('\\BulletItem{', i)
        if start == -1:
            break
        brace_start = start + len('\\BulletItem{')
        depth = 1
        j = brace_start
        while j < len(tex) and depth > 0:
            if tex[j] == '{':
                depth += 1
            elif tex[j] == '}':
                depth -= 1
            j += 1
        content = tex[brace_start:j-1]
        items.append((start, j, content))
        i = j
    return items


def update_bullets(
    tex: str,
    missing: List[str],
    group_defs: Dict[str, List[str]],
    rules: Dict[str, Dict[str, object]],
) -> Tuple[str, List[str]]:
    # Add missing skills to bullets that already mention same group
    items = extract_bullet_items(tex)
    if not items:
        return tex, []

    # Precompute group keywords per bullet
    additions = []
    updated_contents = {start: content for start, _end, content in items}

    display = {
        'data warehouse': 'data warehouse',
        'db modeling': 'data modeling',
        'etl/elt': 'ETL',
        'spark': 'Spark',
        'kafka': 'Kafka',
        'snowflake': 'Snowflake',
        'databricks': 'Databricks',
        'airflow': 'Airflow',
        'aws': 'AWS',
        'gcp': 'GCP',
        'azure': 'Azure',
        'python': 'Python',
        'sql': 'SQL',
        'java': 'Java',
        'scala': 'Scala',
        'docker': 'Docker',
        'kubernetes': 'Kubernetes',
        'terraform': 'Terraform',
        'hadoop': 'Hadoop',
        'hive': 'Hive',
        'postgresql': 'PostgreSQL',
        'mongodb': 'MongoDB',
        'redis': 'Redis',
        'dbt': 'dbt',
        'streaming': 'streaming',
        'aws': 'AWS',
        'gcp': 'GCP',
        'azure': 'Azure',
        'pubsub': 'Pub/Sub',
        'cloud composer': 'Cloud Composer',
        'bigquery': 'BigQuery',
        'snowflake': 'Snowflake',
        'redshift': 'Redshift',
    }

    cloud_providers = set(group_defs.get('cloud_provider', []))
    cloud_rules = rules.get('cloud_provider', {})
    tech_replacements = rules.get('tech_replacements', {})

    def _bold(text: str) -> str:
        return r'\textbf{' + text + '}'

    for canon in missing:
        if canon in cloud_providers:
            cloud_rule = cloud_rules.get(canon) or {}
            target_display = display.get(canon, canon)
            target_display_tex = _bold(target_display)
            other_providers = cloud_rule.get('replace_providers') or [p for p in cloud_providers if p != canon]
            if other_providers:
                pattern = r'\b(' + '|'.join(re.escape(p) for p in other_providers) + r')\b'
                for start, end, content in items:
                    content = updated_contents.get(start, content)
                    content_lower = content.lower()
                    if re.search(r'\b' + re.escape(canon) + r'\b', content_lower):
                        continue
                    if re.search(pattern, content_lower):
                        present = [p for p in other_providers if re.search(r'\b' + re.escape(p) + r'\b', content_lower)]
                        new_content = content
                        service_replacements = cloud_rule.get('service_replacements') or []
                        if present and service_replacements:
                            for pat, rep in service_replacements:
                                new_content = re.sub(pat, _bold(rep), new_content, flags=re.I)
                        for p in present:
                            new_content = re.sub(
                                r'\b' + re.escape(p) + r'\b',
                                target_display_tex,
                                new_content,
                                flags=re.I,
                            )
                        new_content = re.sub(
                            r'(' + re.escape(target_display_tex) + r')(\s*,\s*' + re.escape(target_display_tex) + r')+',
                            r'\1',
                            new_content,
                        )
                        updated_contents[start] = new_content
                        if canon not in additions:
                            additions.append(canon)
            continue

        if canon in tech_replacements:
            tech_rule = tech_replacements.get(canon) or {}
            target_display = display.get(canon, canon)
            target_display_tex = _bold(target_display)
            for start, end, content in items:
                content = updated_contents.get(start, content)
                content_lower = content.lower()
                if re.search(r'\b' + re.escape(canon) + r'\b', content_lower):
                    continue
                new_content = content
                replaced_any = False
                for pat, rep in tech_rule.get('replace', []):
                    rep_tex = _bold(rep)
                    if re.search(pat, new_content):
                        new_content = re.sub(pat, rep_tex, new_content)
                        replaced_any = True
                if replaced_any:
                    updated_contents[start] = new_content
                    if canon not in additions:
                        additions.append(canon)
            continue
    if not updated_contents:
        return tex, additions

    new_tex = tex
    for start, end, _content in sorted(items, key=lambda x: x[0], reverse=True):
        new_content = updated_contents.get(start, _content)
        new_tex = new_tex[:start] + '\\BulletItem{' + new_content + '}' + new_tex[end:]
    return new_tex, additions


def write_resume_skills(path: str, skills: List[str], canonical: List[str]) -> None:
    with open(path, 'w') as f:
        json.dump({
            'resume_skills_raw': skills,
            'resume_skills_canonical': canonical
        }, f, indent=2)


def fetch_url_text_selenium(url: str) -> str:
    try:
        from selenium import webdriver
        from selenium.webdriver.chrome.options import Options
        from selenium.webdriver.chrome.service import Service
    except Exception as e:
        raise RuntimeError(
            'Selenium not available. Install selenium and ensure chromedriver is in PATH.'
        ) from e

    options = Options()
    options.add_argument('--headless=new')
    options.add_argument('--disable-gpu')
    options.add_argument('--no-sandbox')
    options.add_argument('--disable-dev-shm-usage')
    options.add_argument('--window-size=1920,1080')

    chrome_binary = os.getenv('CHROME_BINARY')
    chromedriver_path = os.getenv('CHROMEDRIVER_PATH')
    if chrome_binary:
        options.binary_location = chrome_binary

    # Avoid picking up incompatible chromedriver from PATH; let Selenium Manager download a matching one.
    original_path = os.environ.get('PATH', '')
    try:
        path_parts = [p for p in original_path.split(os.pathsep) if p and 'homebrew/bin' not in p]
        os.environ['PATH'] = os.pathsep.join(path_parts)
        if chromedriver_path:
            service = Service(executable_path=chromedriver_path)
            driver = webdriver.Chrome(service=service, options=options)
        else:
            driver = webdriver.Chrome(options=options)
    finally:
        os.environ['PATH'] = original_path
    try:
        driver.get(url)
        driver.implicitly_wait(5)
        # Scroll to trigger lazy loading
        for frac in (0.3, 0.6, 0.9):
            try:
                driver.execute_script(
                    f"window.scrollTo(0, document.body.scrollHeight * {frac});"
                )
            except Exception:
                pass
        # Try to expand common \"show more\" buttons
        selectors = [
            "button.show-more-less-html__button",
            "button[aria-expanded='false']",
            "button[aria-label*='more']",
            "button[aria-label*='More']",
            "button[aria-label*='Show']",
            "button[aria-label*='See']",
        ]
        for _ in range(3):
            for sel in selectors:
                try:
                    btn = driver.find_element('css selector', sel)
                    btn.click()
                    break
                except Exception:
                    continue
            try:
                driver.execute_script(
                    "window.scrollTo(0, document.body.scrollHeight * 0.8);"
                )
            except Exception:
                pass
        return driver.page_source
    finally:
        driver.quit()


def process_jd_text(desc: str,
                    skills_grouped: str,
                    resume_tex: str,
                    resume_skills_path: str,
                    out_tex: str,
                    out_pdf: str,
                    replacement_rules: str,
                    compile_pdf: bool = True) -> Dict[str, List[str]]:
    if not desc:
        raise SystemExit('Failed to extract job description')

    jd_canons = jd_skills(desc)
    selected_resume_tex = resume_tex
    selected_provider = None
    # Respect explicitly selected custom templates (for example resume_2.tex).
    # Only auto-switch cloud variants when using the default base resume.tex.
    if os.path.basename(resume_tex) == 'resume.tex':
        resume_dir = os.path.dirname(resume_tex)
        resume_candidates = {
            'aws': os.path.join(resume_dir, 'resume_aws.tex'),
            'gcp': os.path.join(resume_dir, 'resume_gcp.tex'),
            'azure': os.path.join(resume_dir, 'resume_azure.tex'),
        }
        if 'aws' in jd_canons and os.path.exists(resume_candidates['aws']):
            selected_resume_tex = resume_candidates['aws']
            selected_provider = 'aws'
        elif 'gcp' in jd_canons and os.path.exists(resume_candidates['gcp']):
            selected_resume_tex = resume_candidates['gcp']
            selected_provider = 'gcp'
        elif 'azure' in jd_canons and os.path.exists(resume_candidates['azure']):
            selected_resume_tex = resume_candidates['azure']
            selected_provider = 'azure'

        if selected_provider:
            cloud_providers = {'aws', 'gcp', 'azure'}
            jd_canons = [c for c in jd_canons if c not in cloud_providers or c == selected_provider]

    with open(selected_resume_tex) as f:
        tex = f.read()

    resume_skills = extract_resume_skills(tex)
    resume_canons = canonicalize(resume_skills)
    write_resume_skills(resume_skills_path, resume_skills, resume_canons)

    group_defs = load_group_defs(skills_grouped)
    rules = load_replacement_rules(replacement_rules)

    missing = [s for s in jd_canons if s not in resume_canons]
    # Replace generic skills with a concrete technology if none is present.
    for generic, techs in GENERIC_SKILL_TECH.items():
        if generic not in missing:
            continue
        concrete_present = any(t in resume_canons or t in missing for t in techs)
        if not concrete_present:
            for tech in techs:
                if tech not in resume_canons and tech not in missing:
                    missing.append(tech)
                    break
        # Always remove the generic skill to avoid clutter.
        missing = [s for s in missing if s != generic]

    missing = [s for s in missing if skill_reasonable(s, resume_canons, group_defs)]

    updated_tex, added_bullets = update_bullets(tex, missing, group_defs, rules)
    missing_for_skills = [s for s in missing if s not in added_bullets]
    updated_tex, added_skills = update_skills_section(updated_tex, missing_for_skills, rules)

    # Remove generic skills that are not part of the base resume.
    generic_display = {
        'data warehouse': 'Data Warehouse',
        'streaming': 'Streaming',
        'db modeling': 'Data Modeling',
        'etl/elt': 'ETL',
    }
    for canon, display_name in generic_display.items():
        if display_name in tex:
            continue
        updated_tex = re.sub(rf'(,\\s*)?\\b{re.escape(display_name)}\\b', '', updated_tex)
        # clean up double commas/spaces
        updated_tex = re.sub(r',\\s*,', ',', updated_tex)
        updated_tex = re.sub(r'\\s+,', ',', updated_tex)

    with open(out_tex, 'w') as f:
        f.write(updated_tex)

    if compile_pdf:
        media_src = os.path.join(os.path.dirname(resume_tex), 'media')
        media_dst = os.path.join(os.path.dirname(out_tex), 'media')
        if os.path.isdir(media_src):
            shutil.rmtree(media_dst, ignore_errors=True)
            shutil.copytree(media_src, media_dst)

        texlive_root = os.path.join('/tmp', 'texlive')
        texmf_var = os.path.join(texlive_root, 'texmf-var')
        texmf_config = os.path.join(texlive_root, 'texmf-config')
        texmf_home = os.path.join(texlive_root, 'texmf-home')
        for path in (texmf_var, texmf_config, texmf_home):
            os.makedirs(path, exist_ok=True)
        os.makedirs(os.path.join('/tmp', 'fontconfig'), exist_ok=True)

        out_dir = os.path.dirname(out_tex)
        # Compile from the output directory so relative media paths resolve.
        compile_cwd = out_dir
        cmd = [
            'xelatex',
            '-interaction=nonstopmode',
            '-halt-on-error',
            f'-output-directory={out_dir}',
            out_tex,
        ]
        env = os.environ.copy()
        env['HOME'] = '/tmp'
        env['FC_CACHEDIR'] = os.path.join('/tmp', 'fontconfig')
        env['XDG_CACHE_HOME'] = '/tmp'
        env['TEXMFVAR'] = texmf_var
        env['TEXMFCONFIG'] = texmf_config
        env['TEXMFHOME'] = texmf_home
        env['VARTEXFONTS'] = os.path.join(texmf_var, 'fonts')
        res = subprocess.run(cmd, cwd=compile_cwd, capture_output=True, text=True, env=env)
        if res.returncode != 0:
            raise SystemExit(res.stdout + '\n' + res.stderr)

        built_pdf = os.path.join(os.path.dirname(out_tex), os.path.splitext(os.path.basename(out_tex))[0] + '.pdf')
        if built_pdf != out_pdf:
            os.replace(built_pdf, out_pdf)

    return {
        'added_skills': added_skills,
        'added_bullets': added_bullets,
        'out_tex': out_tex,
        'out_pdf': out_pdf if compile_pdf else ''
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('url', nargs='?', help='Job description URL')
    ap.add_argument('--jd-text-file', help='Path to plain text JD file')
    ap.add_argument('--jd-text', help='Inline plain text JD')
    ap.add_argument('--fetch-mode', choices=['urllib', 'selenium'], default='urllib')
    ap.add_argument('--skills-grouped', default=DEFAULT_SKILLS_GROUPED)
    ap.add_argument('--resume-tex', default=DEFAULT_RESUME_TEX)
    ap.add_argument('--resume-skills', default=DEFAULT_RESUME_SKILLS)
    ap.add_argument('--out-tex', default=DEFAULT_UPDATED_TEX)
    ap.add_argument('--out-pdf', default=DEFAULT_UPDATED_PDF)
    ap.add_argument('--no-pdf', action='store_true', help='Skip PDF compilation')
    ap.add_argument('--replacement-rules', default=DEFAULT_REPLACEMENT_RULES)
    args = ap.parse_args()

    # Fetch JD
    desc = ''
    if args.jd_text:
        desc = args.jd_text.strip()
    elif args.jd_text_file:
        with open(args.jd_text_file) as f:
            desc = f.read().strip()
    elif args.url:
        if args.fetch_mode == 'selenium':
            html = fetch_url_text_selenium(args.url)
        else:
            html = fetch_url_text(args.url)
        desc = extract_description_from_html(html)
        desc = extract_description(desc)
        if not desc:
            job_id = extract_linkedin_job_id(args.url)
            if job_id:
                guest_html = fetch_linkedin_guest_html(job_id)
                desc = extract_description_from_html(guest_html)
                desc = extract_description(desc)
    result = process_jd_text(
        desc,
        args.skills_grouped,
        args.resume_tex,
        args.resume_skills,
        args.out_tex,
        args.out_pdf,
        replacement_rules=args.replacement_rules,
        compile_pdf=not args.no_pdf
    )

    print('resume_updated_tex', result['out_tex'])
    if result['out_pdf']:
        print('resume_updated_pdf', result['out_pdf'])
    print('added_skills', result['added_skills'])
    print('added_bullets', result['added_bullets'])


def lambda_handler(event, _context):
    # Expected event:
    # { "jd_text": "...", "skills_grouped": "...", "resume_tex": "...",
    #   "resume_skills": "...", "out_tex": "...", "out_pdf": "...", "compile_pdf": false }
    jd_text = event.get('jd_text', '').strip()
    if not jd_text and event.get('jd_text_file'):
        with open(event['jd_text_file']) as f:
            jd_text = f.read().strip()
    if not jd_text:
        raise ValueError('jd_text or jd_text_file is required for Lambda usage')

    skills_grouped = event.get('skills_grouped', DEFAULT_SKILLS_GROUPED)
    resume_tex = event.get('resume_tex', DEFAULT_RESUME_TEX)
    resume_skills = event.get('resume_skills', DEFAULT_RESUME_SKILLS)
    out_tex = event.get('out_tex', DEFAULT_UPDATED_TEX)
    out_pdf = event.get('out_pdf', DEFAULT_UPDATED_PDF)
    replacement_rules = event.get('replacement_rules', DEFAULT_REPLACEMENT_RULES)
    compile_pdf = event.get('compile_pdf', False)

    result = process_jd_text(
        jd_text,
        skills_grouped,
        resume_tex,
        resume_skills,
        out_tex,
        out_pdf,
        replacement_rules,
        compile_pdf=compile_pdf
    )
    return result


if __name__ == '__main__':
    main()
