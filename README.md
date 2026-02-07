# LinkedIn Job Notifier

Scrapes LinkedIn's guest jobs search HTML endpoint, filters for roles, stores job IDs in DynamoDB, and sends Pushover notifications for new matches.

## Behavior
- Fetches job cards from LinkedIn guest endpoint.
- Deduplicates by `jobId` using DynamoDB.
- Matches role keywords against title and job description.
- Sends Pushover notification for each new match.

## AWS Setup (CDK Only)
This project is deployed via AWS CDK (no manual resource creation).

```bash
cd cdk
npm install
npx cdk bootstrap aws://YOUR_ACCOUNT_ID/us-east-1
npx cdk deploy -c pushoverAppToken=YOUR_PUSHOVER_APP_TOKEN
```

The CDK stack creates:
- DynamoDB table `linkedin_jobs` with `jobId` as the partition key.
- Lambda function running the scraper.
- Secrets Manager secret `pinged-in/pushover-app-token`.
- EventBridge Scheduler to run every 30 minutes from 8AM to 10PM (America/New_York, includes 10:30PM).

## Cleanup Test Resources (CDK Only)
To delete the temporary test Lambda and role (`linkedin-guest-check`, `linkedin-guest-check-role`) using CDK:

```bash
cd cdk
npx cdk deploy PingedInCleanupStack -c cleanupTestResources=true
npx cdk destroy PingedInCleanupStack -c cleanupTestResources=true
```

## Environment Variables
- `DYNAMODB_TABLE`: DynamoDB table name.
- `LINKEDIN_KEYWORDS`: Search keywords (default: `Data Engineer`).
- `LINKEDIN_LOCATION`: Search location (default: `United States`).
- `LINKEDIN_GEO_ID`: Optional geoId (example: `103644278`).
- `LINKEDIN_TPR`: Time posted filter fallback (example: `r86400` for last 24h).
- `MAX_TPR_SECONDS`: Upper bound on "since last success" window in seconds (default: `86400`).
- `PAGE_SIZE`: Page size (default: `25`).
- `MAX_PAGES`: Max pages to fetch per run (default: `4`).
- `REQUEST_DELAY_SECONDS`: Delay between requests (default: `0.6`).
- `ROLE_KEYWORDS`: Comma-separated keywords to match in title or description.
- `PUSHOVER_USER_KEY`: Pushover user key (default set to your provided key).
- `PUSHOVER_APP_TOKEN`: Pushover app token.
- `PUSHOVER_APP_TOKEN_SECRET_ARN`: Secrets Manager ARN for the app token (preferred).
- `USER_AGENT`: Optional custom User-Agent.
- `META_KEY`: DynamoDB meta item key (default: `__meta__`).
- `LAST_SUCCESS_ATTR`: Attribute name for last successful search timestamp (default: `lastSuccessEpoch`).

## Local Run
Requires AWS credentials with access to DynamoDB.

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

export DYNAMODB_TABLE=linkedin_jobs
export LINKEDIN_KEYWORDS="Data Engineer"
export LINKEDIN_LOCATION="United States"
export LINKEDIN_GEO_ID=103644278
export LINKEDIN_TPR=r86400
export PUSHOVER_USER_KEY=...
export PUSHOVER_APP_TOKEN=...

python src/local_run.py
```

## Notes
- LinkedIn guest endpoint is undocumented and may change or block requests.
- If LinkedIn blocks requests, consider adding a proxy or a third-party scraping API.
