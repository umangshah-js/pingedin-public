# Resume Augmentation Script (Lambda-Compatible)

This script augments your resume with missing skills from a job description (JD), while only adding skills that are **reasonable** given your existing experience. It updates both:
- The `SKILLS` section
- Relevant experience/project bullets

The script is designed to be used locally **and** inside AWS Lambda (with JD text passed in the event payload).

## Files
- `augment_resume_from_jd.py` – main script (CLI + Lambda handler)
- `skills_grouped.json` – reference skill groupings
- `resume.tex` – input resume
- `resume_skills.json` – extracted resume skills (generated)
- `resume_updated.tex` / `resume_updated.pdf` – output (generated)

## CLI Usage

### 1) Provide JD text inline
```bash
python3 augment_resume_from_jd.py \
  --jd-text "We need Spark, Kafka, Snowflake, Data Warehouse..."
```

### 2) Provide JD text via file
```bash
python3 augment_resume_from_jd.py \
  --jd-text-file /tmp/jd.txt
```

### 3) Provide JD URL (best effort HTML extraction)
```bash
python3 augment_resume_from_jd.py "https://example.com/job"
```

### 4) Skip PDF compilation
```bash
python3 augment_resume_from_jd.py --jd-text-file /tmp/jd.txt --no-pdf
```

## Lambda Usage

### Handler
`augment_resume_from_jd.lambda_handler`

### Event Payload
```json
{
  "jd_text": "We need Spark, Kafka, Snowflake, Data Warehouse...",
  "skills_grouped": "/var/task/skills_grouped.json",
  "resume_tex": "/var/task/resume.tex",
  "resume_skills": "/tmp/resume_skills.json",
  "out_tex": "/tmp/resume_updated.tex",
  "out_pdf": "/tmp/resume_updated.pdf",
  "compile_pdf": false
}
```

### Notes
- For Lambda, pass **JD text**, not a URL. LinkedIn and most job sites block bot scraping.
- `compile_pdf` should generally be `false` in Lambda unless you package LaTeX binaries.
- `out_*` should use `/tmp` (Lambda writable directory).

## Output
The handler returns:
```json
{
  "added_skills": ["Data Warehouse"],
  "added_bullets": ["data warehouse"],
  "out_tex": "/tmp/resume_updated.tex",
  "out_pdf": ""
}
```

## Skill Reasonability Logic
A missing skill is added only if it belongs to a **group already present** in your resume
(e.g., `data_warehouse_concept` is allowed if you already have a data warehouse platform like Snowflake).

You can edit this logic in:
- `skill_reasonable()`
- `update_bullets()`
