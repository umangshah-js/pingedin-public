import os
import json

import boto3

from linkedin_job_scraper import Config, PushoverNotifier, load_overrides, run


def main():
    overrides_path = os.getenv("CONFIG_JSON")
    if overrides_path:
        load_overrides(overrides_path)

    config = Config()
    table = boto3.resource("dynamodb").Table(config.table_name)

    notifier = None
    if config.pushover_user_key and config.pushover_app_token:
        notifier = PushoverNotifier(
            user_key=config.pushover_user_key,
            app_token=config.pushover_app_token,
        )

    stats = run(config, table, notifier)
    print(json.dumps(stats, indent=2))


if __name__ == "__main__":
    main()
