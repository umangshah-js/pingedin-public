# PingedIn - Agent Context

## What this project is
PingedIn is a serverless LinkedIn job monitoring system with a multi-user web portal.

Core capabilities:
- Scheduled LinkedIn guest-job scraping.
- Per-user job matching + Pushover notifications.
- On-demand resume and cover-letter generation from user templates.
- Portal for browsing jobs, managing filters, and admin user operations.

## Current Stack
- Backend: Python 3.12 (AWS Lambda, Docker image functions)
- Frontend: React 18 + React Router 6 + Vite
- Infra: AWS CDK (TypeScript)
- Data: DynamoDB (`linkedin_jobs`)
- Storage: S3 (resume artifacts + portal static site)
- Auth: Cognito User Pool (access token validated by Portal API)
- Scheduling: EventBridge Scheduler
- Notifications: Pushover
- PDF/templating: XeLaTeX + Calibri fonts

## Project Layout (current)
```text
src/
  lambda_function.py          # Scheduled job checker entrypoint (per-user fanout)
  linkedin_job_scraper.py     # Scraping, matching, notifications, artifact generation (~1195 lines)
  portal_api.py               # Authenticated portal API + admin endpoints (~1171 lines)
  resume_url_redirect.py      # Redirects to S3 presigned URLs by jobId/type
  augment_resume_from_jd.py   # Resume augmentation engine
  users/<templateUser>/       # User template folders (resume/cover/skills/rules/media)

portal/
  src/App.jsx                 # Portal UI (~1199 lines)
  src/styles.css              # Portal styles
  src/main.jsx                # HashRouter bootstrap
  dist/                       # Build artifact (deployed by CDK)

cdk/
  lib/pinged-in-stack.ts      # Main stack
  lib/pinged-in-cleanup-stack.ts  # Optional cleanup stack
  bin/pinged-in.ts            # Stack wiring + cleanup context gate
  lambda/Dockerfile           # Job checker container image
  lambda/Dockerfile.portal    # Portal API container image
  lambda/fonts/calibri/       # Required font files for XeLaTeX
```

## Runtime Architecture

### Scheduled pipeline
EventBridge Scheduler (every 30 minutes, 8:00-22:30 America/New_York) invokes `LinkedInJobChecker` Lambda:
- Loads all profile rows with `jobId` prefix `__user__#`.
- Filters users by `enabled` + optional schedule window (`scheduleEnabled`, timezone/start/end).
- Runs scraper per enabled user profile (keywords/location/template/notifier key can vary per user).
- Stores new jobs in DynamoDB with `userIds` ownership.
- Optionally auto-generates resume artifacts (`RESUME_AUTO_GENERATE`; currently `false` in CDK env).
- Sends Pushover notifications (per-user key from profile if set).

If there are no user-profile rows, it falls back to legacy global mode.

### Portal
S3-hosted React app (`HashRouter`) loads `config.json` at runtime and talks to `PortalApi` Lambda Function URL.

Portal API validates Cognito access tokens via `cognito-idp.get_user`, then serves:
- User filter/settings management
- Job listing/detail + add-by-URL
- Resume / cover-letter generation
- Admin-only operations (user creation, token updates, test notification, trigger checker run)

### Resume URL redirect
`ResumeUrlRedirect` Lambda Function URL accepts `jobId` and `type` (`resume`, `summary`, `cover*`) and returns a 302 to a presigned S3 URL.

## DynamoDB Model (`linkedin_jobs`)
- Partition key: `jobId` (string)

Item types:
- Job item: `jobId = <linkedin-id or custom-id>`
- User profile: `jobId = "__user__#<cognito-sub-or-userId>"`
- Meta item: `jobId = "__meta__"` (legacy/global last-success marker)

Important job fields:
- Ownership/multi-user: `userIds` (list)
- Core: `title`, `company`, `location`, `url`, `seenAt`, `compensation`
- Resume/cover legacy top-level fields: `resumeS3Key`, `coverLetterS3Key`, etc.
- Per-user artifacts: `resumeByUser`, `coverLetterByUser`
- Skill metadata: `jdSkills`, `jdSkillsUpdatedAt`

Important profile fields:
- `userId`, `username`, `templateUser`
- `keywords`, `location`, `enabled`
- `notificationUserKey`
- `scheduleEnabled`, `scheduleTimezone`, `scheduleStart`, `scheduleEnd`
- `lastSuccessEpoch`, `updatedAt`

## Portal API Route Surface (suffix-based routing)
The handler checks `path.endswith(...)`, so routes may appear with prefixes (for example `/job/add-url` still matches `/add-url`).

- `GET/POST /user/settings`
- `GET/POST /admin/users` (admin only)
- `POST /admin/user-token` (admin only)
- `POST /admin/test-notification` (admin only)
- `POST /admin/test-run` (admin only)
- `POST /add-url` (used by UI as `/job/add-url`)
- `GET /list`
- `GET /latest`
- `GET /job?jobId=...`
- `POST /job/generate`
- `POST /job/cover-letter`

## Admin + Auth Conventions
- Portal API requires Bearer access token for all non-OPTIONS requests.
- Admin check is currently hardcoded: `_is_admin(identity)` returns true only for username `umang`.
- Cognito user creation in API uses `AdminCreateUser` + `AdminSetUserPassword`.

## Template Conventions
- Template root: `src/users/<templateUser>/`
- Default template user: `umang`
- Supported resume template selection: `resume*.tex` in template dir.
- Cloud auto-selection (`resume_aws.tex`, `resume_gcp.tex`, `resume_azure.tex`) only applies when base template is `resume.tex`.
- Cover letter template placeholders: `[Company]`, `[Role]`, `[Date]`.

## Secrets Manager (CRITICAL)
Secrets are created **externally** (via CLI/console), not by CDK. CDK references them via `fromSecretNameV2`.
- `pinged-in/pushover-app-token` — Pushover app token for notifications
- `pinged-in/gemini-api-key` — Gemini API key for cover letter mission generation

**Rules:**
- **NEVER** use `secretStringValue` on a CDK `Secret` construct without a context gate — every deploy overwrites the value.
- **NEVER** let CDK own secrets (i.e. `new Secret(...)`) without `removalPolicy: RETAIN` — CloudFormation will delete the actual secret if the resource is removed from the stack.
- To set secret values initially, pass context: `npx cdk deploy -c pushoverAppToken=... -c geminiApiKey=...`
- For routine deploys, secrets are looked up via `fromSecretNameV2` and never touched.

## CDK Resources (main stack)
`PingedInStack` creates:
- DynamoDB table `linkedin_jobs`
- S3 resume bucket
- S3 portal bucket + deployments (`portal/dist` and runtime `config.json`)
- Cognito User Pool + app client
- Lambda functions:
  - `LinkedInJobChecker` (Docker image)
  - `PortalApi` (Docker image, Function URL + CORS)
  - `ResumeUrlRedirect` (Python zip, Function URL)
- EventBridge Scheduler + invoke role

Optional stack:
- `PingedInCleanupStack` (enabled with context `cleanupTestResources=true`) removes legacy test Lambda/role resources.

## Deploy
```bash
# Build portal artifact consumed by CDK deployment
cd portal
npm run build

# Deploy stack(s)
cd ../cdk
npx cdk deploy --all --require-approval never
```

## Local Run (job checker)
```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

export DYNAMODB_TABLE=linkedin_jobs
export PUSHOVER_USER_KEY=...
export PUSHOVER_APP_TOKEN=...

python src/local_run.py
```

## High-Signal Env Vars
- Search/matching: `LINKEDIN_KEYWORDS`, `LINKEDIN_LOCATION`, `LINKEDIN_GEO_ID`, `LINKEDIN_TPR`, `MAX_TPR_SECONDS`, `FORCE_TPR`, `ROLE_KEYWORDS`
- Scrape controls: `PAGE_SIZE`, `MAX_PAGES`, `REQUEST_DELAY_SECONDS`, `JD_FETCH_MODE`
- Data: `DYNAMODB_TABLE`, `META_KEY`, `LAST_SUCCESS_ATTR`
- Notification: `PUSHOVER_USER_KEY`, `PUSHOVER_APP_TOKEN`, `PUSHOVER_APP_TOKEN_SECRET_ARN`
- Artifact storage: `RESUME_S3_BUCKET`, `RESUME_S3_PREFIX`, `RESUME_URL_EXPIRES_SECONDS`, `RESUME_URL_BASE`
- Generation: `RESUME_AUTO_GENERATE`, `RESUME_COMPILE_PDF`
- Cover-letter mission enrichment: `COVER_LETTER_MISSION_ENABLED`, `GEMINI_API_KEY`, `GEMINI_API_KEY_SECRET_ARN`, `GEMINI_MODEL`, `GEMINI_TIMEOUT_SECONDS`
- Templates: `USER_TEMPLATES_ROOT`, `DEFAULT_TEMPLATE_USER`, `RESUME_TEX_PATH`, `COVER_LETTER_TEX_PATH`, `SKILLS_GROUPED_PATH`, `REPLACEMENT_RULES_PATH`
- Portal/auth wiring: `COGNITO_USER_POOL_ID`, `COGNITO_APP_CLIENT_ID`, `COGNITO_REGION`, `JOB_CHECKER_FUNCTION_NAME`, `PORTAL_URL_BASE`
- Runtime deps: `CHROME_BINARY`, `CHROMEDRIVER_PATH`, `FONTCONFIG_PATH`, `FONTCONFIG_FILE`

## Gemini Mission Behavior (current)
- Mission text is generated only for manual cover-letter generation (`POST /job/cover-letter`), not during scheduled scraping.
- Gemini call is plain `generateContent` text-only (no `google_search` tool attached).
- Current generation config in code: `temperature=0.2`, `maxOutputTokens=1500`, model from `GEMINI_MODEL` (default `gemini-2.5-flash`).
- **Model fallback**: `_call_gemini_generate` tries the preferred model first, then falls back through `GEMINI_FREE_TIER_MODELS` on 429/503 errors (quota/rate-limit). Models tried in order: `gemini-2.5-flash`, `gemini-2.5-flash-lite`, `gemini-2.0-flash`, `gemini-2.0-flash-lite`, `gemini-1.5-flash`, `gemini-1.5-flash-8b`.
- Logging includes full Gemini raw response JSON, extracted text, and selected mission paragraph.

## File Reading Guide
Read only what is needed for the task:

- Scheduled job checker behavior: `src/lambda_function.py`, `src/linkedin_job_scraper.py`
- Portal backend/API: `src/portal_api.py`
- Resume URL behavior: `src/resume_url_redirect.py`
- Resume augmentation logic: `src/augment_resume_from_jd.py`
- Per-user templates/assets: `src/users/<templateUser>/`
- Frontend behavior/routes: `portal/src/App.jsx`, `portal/src/main.jsx`
- Frontend styling: `portal/src/styles.css`
- Infra/resources/deploy wiring: `cdk/lib/pinged-in-stack.ts`, `cdk/lib/pinged-in-cleanup-stack.ts`, `cdk/bin/pinged-in.ts`
- Container/runtime build issues: `cdk/lambda/Dockerfile`, `cdk/lambda/Dockerfile.portal`
- Python dependencies: `requirements.txt`
- Portal build config: `portal/package.json`, `portal/vite.config.js`
