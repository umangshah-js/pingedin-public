import os

import boto3

from linkedin_job_scraper import Config, PushoverNotifier, run


def handler(event, context):
    event = event or {}
    if isinstance(event, dict):
        force_tpr = event.get("force_tpr")
        debug_html = event.get("debug_html")
        debug_matches = event.get("debug_matches")
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

    notifier = None
    if config.pushover_user_key and config.pushover_app_token:
        notifier = PushoverNotifier(
            user_key=config.pushover_user_key,
            app_token=config.pushover_app_token,
        )

    stats = run(config, table, notifier)
    return {
        "statusCode": 200,
        "stats": stats,
    }


if __name__ == "__main__":
    handler({}, {})
