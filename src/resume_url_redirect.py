import os
import json
import urllib.parse

import boto3


def _response(status_code: int, body: str, headers=None):
    return {
        "statusCode": status_code,
        "headers": headers or {"content-type": "application/json"},
        "body": body,
    }


def handler(event, _context):
    params = (event or {}).get("queryStringParameters") or {}
    job_id = params.get("jobId") if isinstance(params, dict) else None
    file_type = (params.get("type") if isinstance(params, dict) else None) or "resume"
    file_type = (file_type or "").strip().lower()
    if not job_id:
        return _response(400, json.dumps({"error": "Missing jobId"}))

    bucket = os.getenv("RESUME_S3_BUCKET")
    prefix = os.getenv("RESUME_S3_PREFIX", "resumes").strip("/")
    table_name = os.getenv("DYNAMODB_TABLE")
    if not bucket:
        return _response(500, json.dumps({"error": "Missing RESUME_S3_BUCKET"}))

    key = ""
    if table_name:
        try:
            table = boto3.resource("dynamodb").Table(table_name)
            resp = table.get_item(Key={"jobId": job_id})
            item = resp.get("Item") or {}
            if file_type == "summary":
                key = item.get("summaryS3Key", "")
            elif file_type in ("cover", "cover-letter", "cover_letter", "coverletter"):
                key = item.get("coverLetterS3Key", "")
            else:
                key = item.get("resumeS3Key", "")
        except Exception:
            key = ""

    if not key:
        if file_type == "summary":
            filename = "job_summary.pdf"
        elif file_type in ("cover", "cover-letter", "cover_letter", "coverletter"):
            filename = "cover_letter.pdf"
        else:
            filename = "custom_resume.pdf"
        key = f"{prefix}/{job_id}/{filename}" if prefix else f"{job_id}/{filename}"
    s3 = boto3.client("s3")
    url = s3.generate_presigned_url(
        "get_object",
        Params={"Bucket": bucket, "Key": key},
        ExpiresIn=int(os.getenv("RESUME_URL_EXPIRES_SECONDS", "604800")),
    )
    return {
        "statusCode": 302,
        "headers": {"Location": url},
        "body": "",
    }
