import os
from datetime import datetime
from zoneinfo import ZoneInfo

import boto3
from boto3.dynamodb.conditions import Attr

from linkedin_job_scraper import Config, PushoverNotifier, run


USER_PROFILE_PREFIX = "__user__#"


def _is_enabled(value) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() not in ("false", "0", "no", "off")
    if value is None:
        return True
    return bool(value)


def _load_user_profiles(table):
    profiles = []
    scan_kwargs = {
        "FilterExpression": Attr("jobId").begins_with(USER_PROFILE_PREFIX),
    }
    resp = table.scan(**scan_kwargs)
    items = list(resp.get("Items") or [])
    while resp.get("LastEvaluatedKey"):
        resp = table.scan(ExclusiveStartKey=resp["LastEvaluatedKey"], **scan_kwargs)
        items.extend(resp.get("Items") or [])

    for item in items:
        profile_user_id = str(item.get("userId") or "").strip()
        if not profile_user_id:
            job_id = str(item.get("jobId") or "")
            if job_id.startswith(USER_PROFILE_PREFIX):
                profile_user_id = job_id[len(USER_PROFILE_PREFIX):].strip()
        if not profile_user_id:
            continue
        profiles.append((profile_user_id, item))
    return profiles


def _parse_hhmm(value: str):
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


def _is_schedule_active(profile, now_utc: datetime) -> bool:
    if not _is_enabled(profile.get("scheduleEnabled", False)):
        return True
    timezone_name = str(profile.get("scheduleTimezone") or "America/New_York").strip()
    start_hhmm = str(profile.get("scheduleStart") or "").strip()
    end_hhmm = str(profile.get("scheduleEnd") or "").strip()
    start_mins = _parse_hhmm(start_hhmm)
    end_mins = _parse_hhmm(end_hhmm)
    if start_mins is None or end_mins is None:
        return False
    try:
        local_now = now_utc.astimezone(ZoneInfo(timezone_name))
    except Exception:
        return False
    current_mins = local_now.hour * 60 + local_now.minute
    if end_mins >= start_mins:
        duration = end_mins - start_mins
        if duration <= 0 or duration > 14 * 60:
            return False
        return start_mins <= current_mins < end_mins
    duration = (24 * 60 - start_mins) + end_mins
    if duration <= 0 or duration > 14 * 60:
        return False
    return current_mins >= start_mins or current_mins < end_mins


def handler(event, context):
    event = event or {}
    target_username = ""
    if isinstance(event, dict):
        force_tpr = event.get("force_tpr")
        debug_html = event.get("debug_html")
        debug_matches = event.get("debug_matches")
        target_username = str(event.get("username") or "").strip().lower()
        if force_tpr:
            os.environ["FORCE_TPR"] = str(force_tpr)
        if debug_html is not None:
            os.environ["DEBUG_HTML"] = "true" if debug_html else "false"
        if debug_matches is not None:
            os.environ["DEBUG_MATCHES"] = "true" if debug_matches else "false"

    config = Config()

    if not config.table_name:
        raise RuntimeError("DYNAMODB_TABLE env var is required")

    table = boto3.resource("dynamodb").Table(config.table_name)

    default_notifier = None
    if config.pushover_user_key and config.pushover_app_token:
        default_notifier = PushoverNotifier(
            user_key=config.pushover_user_key,
            app_token=config.pushover_app_token,
        )

    user_profiles = _load_user_profiles(table)
    now_utc = datetime.utcnow().replace(tzinfo=ZoneInfo("UTC"))
    enabled_profiles = [
        (profile_user_id, profile)
        for profile_user_id, profile in user_profiles
        if _is_enabled(profile.get("enabled", True)) and _is_schedule_active(profile, now_utc)
    ]
    if target_username:
        enabled_profiles = [
            (profile_user_id, profile)
            for profile_user_id, profile in enabled_profiles
            if str(profile.get("username") or "").strip().lower() == target_username
        ]
    if user_profiles:
        aggregate = {"fetched": 0, "new": 0, "notified": 0}
        per_user = {}
        for profile_user_id, profile in enabled_profiles:
            user_config = Config()
            profile_user_key = str(profile.get("notificationUserKey") or "").strip()
            profile_notifier = None
            if profile_user_key and user_config.pushover_app_token:
                profile_notifier = PushoverNotifier(
                    user_key=profile_user_key,
                    app_token=user_config.pushover_app_token,
                )
            user_stats = run(
                user_config,
                table,
                profile_notifier,
                user_id=profile_user_id,
                user_profile=profile,
            )
            per_user[profile_user_id] = user_stats
            for key in aggregate.keys():
                aggregate[key] += int(user_stats.get(key, 0))
        stats = aggregate
        mode = "per-user"
    else:
        stats = run(config, table, default_notifier)
        per_user = {}
        mode = "global"

    return {
        "statusCode": 200,
        "mode": mode,
        "targetUsername": target_username,
        "users": len(enabled_profiles),
        "profiles": len(user_profiles),
        "stats": stats,
        "perUser": per_user,
    }


if __name__ == "__main__":
    handler({}, {})
