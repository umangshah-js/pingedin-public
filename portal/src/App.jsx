import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Navigate, Link, useNavigate, useParams, useSearchParams, useLocation, Routes, Route } from 'react-router-dom';
const ACCESS_TOKEN_STORAGE_KEY = "pingedin.portal.accessToken";
const REFRESH_TOKEN_STORAGE_KEY = "pingedin.portal.refreshToken";

function readGlobalSearchParams() {
  if (typeof window === "undefined") return new URLSearchParams();
  return new URLSearchParams(window.location.search || "");
}

function getQueryParam(routeSearchParams, key, { allowGlobal = false } = {}) {
  const routeValue = routeSearchParams.get(key);
  if (routeValue) return routeValue;
  if (!allowGlobal) return "";
  const globalParams = readGlobalSearchParams();
  return globalParams.get(key) || "";
}

async function loadConfig() {
  const res = await fetch("config.json", { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load config.json (${res.status})`);
  const cfg = await res.json();
  const apiBase = (cfg.apiBase || "").replace(/\/$/, "");
  if (!apiBase || !cfg.cognitoRegion || !cfg.cognitoClientId) {
    throw new Error("Missing required portal config");
  }
  return {
    apiBase,
    cognitoRegion: cfg.cognitoRegion,
    cognitoClientId: cfg.cognitoClientId,
  };
}

async function cognitoInitiateAuth(config, authFlow, authParameters) {
  const res = await fetch(`https://cognito-idp.${config.cognitoRegion}.amazonaws.com/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": "AWSCognitoIdentityProviderService.InitiateAuth",
    },
    body: JSON.stringify({
      AuthFlow: authFlow,
      ClientId: config.cognitoClientId,
      AuthParameters: authParameters,
    }),
  });
  const payload = await res.json();
  if (!res.ok) {
    const msg = payload && (payload.message || payload.__type)
      ? `${payload.__type || "AuthError"}: ${payload.message || ""}`
      : `Auth failed (${res.status})`;
    throw new Error(msg);
  }
  if (payload.ChallengeName) {
    throw new Error(`Unsupported auth challenge: ${payload.ChallengeName}`);
  }
  return payload.AuthenticationResult || {};
}

function readInitialTokens() {
  return {
    accessToken: localStorage.getItem(ACCESS_TOKEN_STORAGE_KEY) || "",
    refreshToken: localStorage.getItem(REFRESH_TOKEN_STORAGE_KEY) || "",
  };
}

function writeTokens(tokens) {
  if (tokens.accessToken) {
    localStorage.setItem(ACCESS_TOKEN_STORAGE_KEY, tokens.accessToken);
  } else {
    localStorage.removeItem(ACCESS_TOKEN_STORAGE_KEY);
  }
  if (tokens.refreshToken) {
    localStorage.setItem(REFRESH_TOKEN_STORAGE_KEY, tokens.refreshToken);
  } else {
    localStorage.removeItem(REFRESH_TOKEN_STORAGE_KEY);
  }
}

function usePortalAuth(config) {
  const [tokens, setTokens] = useState(() => readInitialTokens());

  const hasSession = !!(tokens.accessToken || tokens.refreshToken);

  const updateTokens = useCallback((next) => {
    const value = {
      accessToken: next?.accessToken || "",
      refreshToken: next?.refreshToken || "",
    };
    setTokens(value);
    writeTokens(value);
  }, []);

  const clearSession = useCallback(() => updateTokens({ accessToken: "", refreshToken: "" }), [updateTokens]);

  const refreshAccessToken = useCallback(async () => {
    if (!tokens.refreshToken) throw new Error("No refresh token available");
    const result = await cognitoInitiateAuth(config, "REFRESH_TOKEN_AUTH", {
      REFRESH_TOKEN: tokens.refreshToken,
    });
    if (!result.AccessToken) throw new Error("No access token returned from refresh");
    updateTokens({
      accessToken: result.AccessToken,
      refreshToken: result.RefreshToken || tokens.refreshToken,
    });
    return result.AccessToken;
  }, [config, tokens.refreshToken, updateTokens]);

  const signIn = useCallback(async (username, password) => {
    const result = await cognitoInitiateAuth(config, "USER_PASSWORD_AUTH", {
      USERNAME: username,
      PASSWORD: password,
    });
    if (!result.AccessToken || !result.RefreshToken) {
      throw new Error("Authentication response missing tokens");
    }
    updateTokens({ accessToken: result.AccessToken, refreshToken: result.RefreshToken });
  }, [config, updateTokens]);

  const apiFetch = useCallback(async (path, options = {}) => {
    let accessToken = tokens.accessToken;
    if (!accessToken && tokens.refreshToken) {
      accessToken = await refreshAccessToken();
    }
    if (!accessToken) throw new Error("Not signed in");

    const requestOptions = { ...options };
    const headers = {
      ...(requestOptions.headers || {}),
      Authorization: `Bearer ${accessToken}`,
    };

    let res = await fetch(`${config.apiBase}${path}`, { ...requestOptions, headers });
    if (res.status === 401 && tokens.refreshToken) {
      try {
        const refreshed = await refreshAccessToken();
        const retryHeaders = {
          ...(requestOptions.headers || {}),
          Authorization: `Bearer ${refreshed}`,
        };
        res = await fetch(`${config.apiBase}${path}`, { ...requestOptions, headers: retryHeaders });
      } catch (_err) {
        clearSession();
      }
    }

    if (res.status === 401) clearSession();
    return res;
  }, [clearSession, config.apiBase, refreshAccessToken, tokens.accessToken, tokens.refreshToken]);

  return useMemo(() => ({
    hasSession,
    tokens,
    signIn,
    apiFetch,
    clearSession,
    setTokens: updateTokens,
  }), [apiFetch, clearSession, hasSession, signIn, tokens, updateTokens]);
}

function ProtectedRoute({ hasSession, children }) {
  const location = useLocation();
  if (!hasSession) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  return children;
}

function Header({ hasSession, onLogout, isAdmin }) {
  return (
    <header className="card topbar">
      <div>
        <h1>PingedIn Portal</h1>
      </div>
      {hasSession ? (
        <div className="topbar-actions">
          <Link className="link-btn" to="/jobs">Jobs</Link>
          <Link className="link-btn" to="/filters">Filters</Link>
          {isAdmin ? <Link className="link-btn" to="/admin">Admin</Link> : null}
          <button className="btn-ghost" onClick={onLogout}>Sign Out</button>
        </div>
      ) : null}
    </header>
  );
}

function InlineLoader({ label = "Loading..." }) {
  return (
    <div className="loader-wrap">
      <div className="loader-spinner" />
      <div className="muted">{label}</div>
    </div>
  );
}

function LoginPage({ auth, setStatus }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const from = location.state?.from || "/jobs";

  useEffect(() => {
    setStatus("Sign in to continue.", false);
  }, [setStatus]);

  if (auth.hasSession) {
    return <Navigate to="/jobs" replace />;
  }

  const onSubmit = async (event) => {
    event.preventDefault();
    setSubmitting(true);
    setStatus("Signing in...", false);
    try {
      await auth.signIn(username.trim(), password);
      setPassword("");
      setStatus("Signed in.", false);
      navigate(from, { replace: true });
    } catch (err) {
      setStatus(`Sign in failed (${err})`, true);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="auth-layout">
      <div className="card auth-copy">
        <div className="section-title">Welcome</div>
        <h2 className="auth-title">Track jobs, tailor applications, and move quickly.</h2>
        <p className="muted">Sign in to access saved listings, resume generation, and cover letter actions.</p>
      </div>
      <div className="card auth-card">
        <div className="section-title">Sign In</div>
        <form onSubmit={onSubmit}>
          <div className="grid auth-fields">
            <div>
              <div className="label">Username</div>
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                disabled={submitting}
              />
            </div>
            <div>
              <div className="label">Password</div>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                disabled={submitting}
              />
            </div>
          </div>
          <div className="buttons">
            <button className="btn-primary" type="submit" disabled={submitting || !username || !password}>
              Sign In
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function UserSettingsCard({ auth, setStatus }) {
  const commonTimezones = [
    "America/New_York",
    "America/Chicago",
    "America/Denver",
    "America/Los_Angeles",
    "America/Phoenix",
    "America/Anchorage",
    "Pacific/Honolulu",
    "UTC",
    "Europe/London",
    "Europe/Berlin",
    "Asia/Kolkata",
  ];

  const [settings, setSettings] = useState({
    keywords: "",
    location: "",
    enabled: true,
    scheduleEnabled: false,
    scheduleTimezone: "America/New_York",
    scheduleStart: "09:00",
    scheduleEnd: "17:00",
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const loadSettings = async () => {
      setLoading(true);
      try {
        const res = await auth.apiFetch("/user/settings");
        if (!res.ok) {
          setStatus(`Failed to load filters (${res.status}) ${await res.text()}`, true);
          return;
        }
        const payload = await res.json();
        if (cancelled) return;
        const next = payload.settings || {};
        setSettings({
          keywords: next.keywords || "",
          location: next.location || "",
          enabled: Boolean(next.enabled ?? true),
          scheduleEnabled: Boolean(next.scheduleEnabled ?? false),
          scheduleTimezone: next.scheduleTimezone || "America/New_York",
          scheduleStart: next.scheduleStart || "09:00",
          scheduleEnd: next.scheduleEnd || "17:00",
        });
      } catch (err) {
        setStatus(`Failed to load filters (${err})`, true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    loadSettings();
    return () => { cancelled = true; };
  }, [auth.apiFetch, setStatus]);

  const onChange = (key, value) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  const parseHhmm = (value) => {
    const parts = String(value || "").split(":");
    if (parts.length !== 2) return null;
    const h = Number(parts[0]);
    const m = Number(parts[1]);
    if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 23 || m < 0 || m > 59) return null;
    return h * 60 + m;
  };

  const scheduleDurationMinutes = () => {
    const start = parseHhmm(settings.scheduleStart);
    const end = parseHhmm(settings.scheduleEnd);
    if (start === null || end === null) return null;
    return end >= start ? end - start : (24 * 60 - start) + end;
  };

  const saveSettings = async () => {
    if (settings.scheduleEnabled) {
      const duration = scheduleDurationMinutes();
      if (duration === null || duration <= 0) {
        setStatus("Schedule start/end is invalid.", true);
        return;
      }
      if (duration > 14 * 60) {
        setStatus("Schedule window cannot exceed 14 hours.", true);
        return;
      }
    }
    setSaving(true);
    setStatus("Saving filters...", false);
    try {
      const res = await auth.apiFetch("/user/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          keywords: settings.keywords.trim(),
          location: settings.location.trim(),
          enabled: settings.enabled,
          scheduleEnabled: settings.scheduleEnabled,
          scheduleTimezone: settings.scheduleTimezone.trim(),
          scheduleStart: settings.scheduleStart,
          scheduleEnd: settings.scheduleEnd,
        }),
      });
      if (!res.ok) {
        setStatus(`Failed to save filters (${res.status}) ${await res.text()}`, true);
        return;
      }
      setStatus("Filters saved.", false);
    } catch (err) {
      setStatus(`Failed to save filters (${err})`, true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card">
      <div className="jobs-header">
        <div>
          <div className="section-title">Your Filters</div>
          <div className="muted">These filters are used for your scheduled pulls.</div>
        </div>
      </div>
      {loading ? <div className="muted">Loading filters...</div> : null}
      {!loading ? (
        <>
          <div className="settings-grid">
            <div>
              <div className="label">Keywords</div>
              <input value={settings.keywords} onChange={(e) => onChange("keywords", e.target.value)} />
            </div>
            <div>
              <div className="label">Location</div>
              <input value={settings.location} onChange={(e) => onChange("location", e.target.value)} />
            </div>
          </div>
          <label className="switch-row">
            <input
              type="checkbox"
              checked={settings.enabled}
              onChange={(e) => onChange("enabled", e.target.checked)}
            />
            <span>Enable scheduled pulls for this account</span>
          </label>
          <label className="switch-row">
            <input
              type="checkbox"
              checked={settings.scheduleEnabled}
              onChange={(e) => onChange("scheduleEnabled", e.target.checked)}
            />
            <span>Use active schedule window</span>
          </label>
          {settings.scheduleEnabled ? (
            <div className="settings-grid">
              <div>
                <div className="label">Timezone (IANA)</div>
                <select
                  value={settings.scheduleTimezone}
                  onChange={(e) => onChange("scheduleTimezone", e.target.value)}
                >
                  {commonTimezones.map((tz) => (
                    <option key={tz} value={tz}>{tz}</option>
                  ))}
                </select>
              </div>
              <div>
                <div className="label">Start / End</div>
                <div className="time-range-row">
                  <input type="time" value={settings.scheduleStart} onChange={(e) => onChange("scheduleStart", e.target.value)} />
                  <input type="time" value={settings.scheduleEnd} onChange={(e) => onChange("scheduleEnd", e.target.value)} />
                </div>
                <div className="muted">
                  Max 14 hours. Current: {(() => {
                    const duration = scheduleDurationMinutes();
                    if (duration === null) return "invalid";
                    const h = Math.floor(duration / 60);
                    const m = duration % 60;
                    return `${h}h ${m}m`;
                  })()}
                </div>
              </div>
            </div>
          ) : null}
          <div className="buttons">
            <button className="btn-primary" disabled={saving} onClick={saveSettings}>Save Filters</button>
          </div>
        </>
      ) : null}
    </div>
  );
}

function JobsPage({ auth, setStatus }) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [jobs, setJobs] = useState([]);
  const [pageIndex, setPageIndex] = useState(0);
  const [jobSearchInput, setJobSearchInput] = useState("");
  const [jobSearchQuery, setJobSearchQuery] = useState("");
  const [totalCount, setTotalCount] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [newJobUrl, setNewJobUrl] = useState("");
  const [addingJob, setAddingJob] = useState(false);
  const pageSize = 10;
  const requestedJobId = getQueryParam(searchParams, "jobId");
  const requestedJdUrl = getQueryParam(searchParams, "jdUrl") || getQueryParam(searchParams, "jd_url");

  if (requestedJobId) {
    const nextParams = new URLSearchParams();
    if (requestedJdUrl) nextParams.set("jdUrl", requestedJdUrl);
    const suffix = nextParams.toString() ? `?${nextParams.toString()}` : "";
    return <Navigate to={`/jobs/${encodeURIComponent(requestedJobId)}${suffix}`} replace />;
  }

  useEffect(() => {
    const timer = setTimeout(() => {
      setJobSearchQuery(jobSearchInput.trim());
    }, 250);
    return () => clearTimeout(timer);
  }, [jobSearchInput]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const page = pageIndex + 1;
        const query = new URLSearchParams();
        query.set("page", String(page));
        query.set("pageSize", String(pageSize));
        if (jobSearchQuery) query.set("q", jobSearchQuery);
        const res = await auth.apiFetch(`/list?${query.toString()}`);
        if (!res.ok) {
          setStatus(`Failed to load jobs (${res.status}) ${await res.text()}`, true);
          return;
        }
        const data = await res.json();
        if (!cancelled) {
          setJobs(data.items || []);
          setTotalCount(Number(data.totalCount || 0));
          setTotalPages(Math.max(1, Number(data.totalPages || 1)));
          setStatus("", false);
        }
      } catch (err) {
        setStatus(`Failed to load jobs (${err})`, true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [pageIndex, jobSearchQuery, auth.apiFetch, setStatus]);

  const addJobByUrl = async () => {
    const jdUrl = newJobUrl.trim();
    if (!jdUrl) {
      setStatus("Please provide a job URL.", true);
      return;
    }
    setAddingJob(true);
    setStatus("Adding job...", false);
    try {
      const res = await auth.apiFetch("/job/add-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jdUrl }),
      });
      if (!res.ok) {
        setStatus(`Failed to add job (${res.status}) ${await res.text()}`, true);
        return;
      }
      const data = await res.json();
      const nextJobId = data.jobId || data?.job?.jobId || "";
      if (!nextJobId) {
        setStatus("Job added but no jobId was returned.", true);
        return;
      }
      setNewJobUrl("");
      setStatus("Job added.", false);
      const nextParams = new URLSearchParams();
      nextParams.set("jdUrl", jdUrl);
      navigate(`/jobs/${encodeURIComponent(nextJobId)}?${nextParams.toString()}`);
    } catch (err) {
      setStatus(`Failed to add job (${err})`, true);
    } finally {
      setAddingJob(false);
    }
  };

  if (loading) {
    return <div className="card"><InlineLoader label="Loading jobs..." /></div>;
  }

  return (
      <div className="card">
        <div className="jobs-header">
          <div>
            <div className="section-title">Recent Jobs</div>
            <div className="muted">Sorted by newest seen first</div>
          </div>
          <div className="pill">{totalCount} total</div>
        </div>
        <div className="label">Search Jobs</div>
        <div className="row">
          <input
            value={jobSearchInput}
            onChange={(e) => {
              setJobSearchInput(e.target.value);
              setPageIndex(0);
            }}
            placeholder="Search by title, company, location, compensation, or job ID"
          />
          <button
            className="btn-ghost"
            disabled={!jobSearchInput.trim()}
            onClick={() => {
              setJobSearchInput("");
              setJobSearchQuery("");
              setPageIndex(0);
            }}
          >
            Clear
          </button>
        </div>
        {jobSearchQuery ? <div className="muted">Searching for "{jobSearchQuery}"</div> : null}
        <div className="label">Add Job by URL</div>
        <div className="row">
          <input
            value={newJobUrl}
            onChange={(e) => setNewJobUrl(e.target.value)}
            placeholder="https://www.linkedin.com/jobs/view/..."
          />
          <button className="btn-primary" disabled={addingJob || !newJobUrl.trim()} onClick={addJobByUrl}>
            {addingJob ? "Adding..." : "Add Job"}
          </button>
        </div>
        <div className="muted">Add a job link to your list and open its details.</div>
        {jobs.length === 0 ? (
          <div className="muted">
            {jobSearchQuery ? "No jobs matched your search." : "No jobs found for this account."}
          </div>
        ) : null}
        {jobs.map((item) => (
          <div className="job-row" key={item.jobId}>
            <div className="value"><strong>{item.title || "Untitled"}</strong></div>
            <div className="muted">{item.company || ""} • {item.location || ""}{item.compensation ? ` • ${item.compensation}` : ""}</div>
            <div className="muted">{item.resumePdfUploaded ? "Resume ready" : "Resume not generated"}</div>
            <div className="muted">{item.coverLetterPdfUploaded ? "Cover letter ready" : "Cover letter not generated"}</div>
            <div style={{ marginTop: 8 }}>
              <Link className="link-btn" to={`/jobs/${encodeURIComponent(item.jobId)}`}>Open Details</Link>
            </div>
          </div>
        ))}
        <div className="buttons pager-buttons">
          <button className="btn-ghost" disabled={pageIndex === 0} onClick={() => setPageIndex((x) => Math.max(0, x - 1))}>Previous</button>
          <button className="btn-ghost" disabled={pageIndex + 1 >= totalPages} onClick={() => setPageIndex((x) => Math.min(totalPages - 1, x + 1))}>Next</button>
        </div>
        <div className="muted pager-text">Page {pageIndex + 1} of {totalPages}</div>
    </div>
  );
}

function FiltersPage({ auth, setStatus }) {
  return <UserSettingsCard auth={auth} setStatus={setStatus} />;
}

function AdminPage({ auth, setStatus, isAdmin }) {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [tokenUsername, setTokenUsername] = useState("");
  const [notificationUserKey, setNotificationUserKey] = useState("");
  const [testUsername, setTestUsername] = useState("");
  const [testMessage, setTestMessage] = useState("PingedIn test notification");
  const [runUsername, setRunUsername] = useState("");
  const [forceTpr, setForceTpr] = useState("r3600");

  const loadUsers = useCallback(async () => {
    setLoading(true);
    try {
      const res = await auth.apiFetch("/admin/users");
      if (!res.ok) {
        setStatus(`Failed to load users (${res.status}) ${await res.text()}`, true);
        return;
      }
      const payload = await res.json();
      const list = payload.users || [];
      setUsers(list);
      if (!tokenUsername && list.length > 0) setTokenUsername(list[0].username || list[0].userId || "");
      if (!testUsername && list.length > 0) setTestUsername(list[0].username || list[0].userId || "");
      setStatus("Ready", false);
    } catch (err) {
      setStatus(`Failed to load users (${err})`, true);
    } finally {
      setLoading(false);
    }
  }, [auth.apiFetch, setStatus, tokenUsername, testUsername]);

  useEffect(() => {
    loadUsers();
  }, [loadUsers]);

  useEffect(() => {
    const selected = users.find((u) => (u.username || u.userId) === tokenUsername);
    setNotificationUserKey(selected?.effectiveNotificationUserKey || selected?.notificationUserKey || "");
  }, [users, tokenUsername]);

  if (!isAdmin) {
    return <Navigate to="/jobs" replace />;
  }

  const createUser = async () => {
    setStatus("Creating user...", false);
    try {
      const res = await auth.apiFetch("/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: username.trim().toLowerCase(),
          password,
        }),
      });
      if (!res.ok) {
        setStatus(`Failed to create user (${res.status}) ${await res.text()}`, true);
        return;
      }
      setUsername("");
      setPassword("");
      setStatus("User created.", false);
      await loadUsers();
    } catch (err) {
      setStatus(`Failed to create user (${err})`, true);
    }
  };

  const updateToken = async () => {
    setStatus("Updating user token...", false);
    try {
      const res = await auth.apiFetch("/admin/user-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: tokenUsername,
          notificationUserKey: notificationUserKey.trim(),
        }),
      });
      if (!res.ok) {
        setStatus(`Failed to update token (${res.status}) ${await res.text()}`, true);
        return;
      }
      setStatus("User token updated.", false);
      await loadUsers();
    } catch (err) {
      setStatus(`Failed to update token (${err})`, true);
    }
  };

  const sendTestNotification = async () => {
    setStatus("Sending test notification...", false);
    try {
      const res = await auth.apiFetch("/admin/test-notification", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: testUsername,
          message: testMessage.trim(),
        }),
      });
      if (!res.ok) {
        setStatus(`Failed to send test notification (${res.status}) ${await res.text()}`, true);
        return;
      }
      setStatus("Test notification sent.", false);
    } catch (err) {
      setStatus(`Failed to send test notification (${err})`, true);
    }
  };

  const triggerTestRun = async () => {
    setStatus("Triggering test lambda run...", false);
    try {
      const res = await auth.apiFetch("/admin/test-run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: runUsername.trim().toLowerCase(),
          force_tpr: forceTpr.trim(),
        }),
      });
      if (!res.ok) {
        setStatus(`Failed to trigger test run (${res.status}) ${await res.text()}`, true);
        return;
      }
      setStatus("Test lambda run triggered.", false);
    } catch (err) {
      setStatus(`Failed to trigger test run (${err})`, true);
    }
  };

  return (
    <>
      <div className="card">
        <div className="section-title">Admin</div>
        <div className="muted">Manage users and test notifications/runs.</div>
        <div className="buttons">
          <button className="btn-ghost" onClick={loadUsers} disabled={loading}>
            {loading ? "Refreshing..." : "Refresh Users"}
          </button>
        </div>
      </div>

      <div className="card">
        <div className="section-title">Create User</div>
        <div className="settings-grid">
          <div>
            <div className="label">Username</div>
            <input value={username} onChange={(e) => setUsername(e.target.value)} />
          </div>
          <div>
            <div className="label">Password</div>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
        </div>
        <div className="buttons">
          <button className="btn-primary" onClick={createUser} disabled={!username.trim() || !password}>Create User</button>
        </div>
      </div>

      <div className="card">
        <div className="section-title">Update User Token</div>
        <div className="settings-grid">
          <div>
            <div className="label">Username</div>
            <select value={tokenUsername} onChange={(e) => setTokenUsername(e.target.value)}>
              <option value="">Select user</option>
              {users.map((u) => (
                <option key={u.userId} value={u.username || u.userId}>
                  {u.displayName || u.username || u.userId}
                </option>
              ))}
            </select>
          </div>
          <div>
            <div className="label">Notification User Key</div>
            <input value={notificationUserKey} onChange={(e) => setNotificationUserKey(e.target.value)} />
          </div>
        </div>
        <div className="buttons">
          <button className="btn-primary" onClick={updateToken} disabled={!tokenUsername}>Update Token</button>
        </div>
      </div>

      <div className="card">
        <div className="section-title">Test Notification</div>
        <div className="settings-grid">
          <div>
            <div className="label">Username</div>
            <select value={testUsername} onChange={(e) => setTestUsername(e.target.value)}>
              <option value="">Select user</option>
              {users.map((u) => (
                <option key={u.userId} value={u.username || u.userId}>
                  {u.displayName || u.username || u.userId}
                </option>
              ))}
            </select>
          </div>
          <div>
            <div className="label">Message</div>
            <input value={testMessage} onChange={(e) => setTestMessage(e.target.value)} />
          </div>
        </div>
        <div className="buttons">
          <button className="btn-primary" onClick={sendTestNotification} disabled={!testUsername}>Send Test Notification</button>
        </div>
      </div>

      <div className="card">
        <div className="section-title">Trigger Test Lambda Run</div>
        <div className="settings-grid">
          <div>
            <div className="label">Username (optional)</div>
            <input
              value={runUsername}
              onChange={(e) => setRunUsername(e.target.value)}
              placeholder="Leave blank to run all enabled users"
            />
          </div>
          <div>
            <div className="label">force_tpr</div>
            <input value={forceTpr} onChange={(e) => setForceTpr(e.target.value)} />
          </div>
        </div>
        <div className="buttons">
          <button className="btn-primary" onClick={triggerTestRun}>Trigger Test Run</button>
        </div>
      </div>
    </>
  );
}

function renderList(items, emptyLabel = "None") {
  if (!items || items.length === 0) return <span className="muted">{emptyLabel}</span>;
  return <ul>{items.map((item, i) => <li key={`${item}-${i}`}>{item}</li>)}</ul>;
}

function JobDetailsPage({ auth, setStatus }) {
  const { jobId } = useParams();
  const [searchParams] = useSearchParams();
  const jdUrl = searchParams.get("jdUrl") || searchParams.get("jd_url") || "";
  const [payload, setPayload] = useState(null);
  const [loading, setLoading] = useState(true);
  const [generatingResume, setGeneratingResume] = useState(false);
  const [generatingCover, setGeneratingCover] = useState(false);
  const [selectedResumeTemplate, setSelectedResumeTemplate] = useState("resume.tex");

  const loadJob = async () => {
    setLoading(true);
    setStatus("Loading job...", false);
    try {
      const params = new URLSearchParams();
      params.set("jobId", String(jobId || ""));
      if (selectedResumeTemplate) params.set("resumeTemplate", selectedResumeTemplate);
      const res = await auth.apiFetch(`/job?${params.toString()}`);
      if (!res.ok) {
        setStatus(`Failed to load job (${res.status}) ${await res.text()}`, true);
        return;
      }
      const data = await res.json();
      setPayload(data);
      const templates = Array.isArray(data.resumeTemplates) ? data.resumeTemplates : [];
      const nextTemplate = data.selectedResumeTemplate || templates[0] || "resume.tex";
      setSelectedResumeTemplate(nextTemplate);
      setStatus("Ready", false);
    } catch (err) {
      setStatus(`Failed to load job (${err})`, true);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadJob();
  }, [jobId]);

  const resumeUrl = payload?.resumeUrl || payload?.job?.resumeUrl || "";
  const coverLetterUrl = payload?.coverLetterUrl || payload?.job?.coverLetterUrl || "";

  const generateResume = async () => {
    setGeneratingResume(true);
    setStatus("Generating resume...", false);
    try {
      const params = new URLSearchParams();
      if (jobId) params.set("jobId", jobId);
      if (jdUrl) params.set("jdUrl", jdUrl);
      if (selectedResumeTemplate) params.set("resumeTemplate", selectedResumeTemplate);
      const res = await auth.apiFetch(`/job/generate?${params.toString()}`, { method: "POST" });
      if (!res.ok) {
        setStatus(`Failed to generate resume (${res.status}) ${await res.text()}`, true);
        return;
      }
      await loadJob();
    } catch (err) {
      setStatus(`Failed to generate resume (${err})`, true);
    } finally {
      setGeneratingResume(false);
    }
  };

  const generateCover = async () => {
    setGeneratingCover(true);
    setStatus("Generating cover letter...", false);
    try {
      const params = new URLSearchParams();
      if (jobId) params.set("jobId", jobId);
      if (jdUrl) params.set("jdUrl", jdUrl);
      const res = await auth.apiFetch(`/job/cover-letter?${params.toString()}`, { method: "POST" });
      if (!res.ok) {
        setStatus(`Failed to generate cover letter (${res.status}) ${await res.text()}`, true);
        return;
      }
      await loadJob();
    } catch (err) {
      setStatus(`Failed to generate cover letter (${err})`, true);
    } finally {
      setGeneratingCover(false);
    }
  };

  if (loading) {
    return <div className="card"><InlineLoader label="Loading job..." /></div>;
  }

  if (!payload) {
    return <div className="card"><div className="error">Job not found.</div></div>;
  }

  const job = payload.job || {};
  const augment = payload.augment || {};
  const summary = payload.summary || {};
  const resumeGeneratedAt = payload.resumeGeneratedAt || 0;
  const coverGeneratedAt = payload.coverLetterGeneratedAt || 0;
  const organizationMission = payload.organizationMission || payload?.job?.organizationMission || "";
  const hasResume = Boolean(payload.resumeExistsForUser || resumeUrl);
  const hasCoverLetter = Boolean(payload.coverLetterExistsForUser || coverLetterUrl);
  const hasAnyGeneratedArtifact = hasResume || hasCoverLetter;
  const canGenerateForUser = Boolean(payload.templateAvailable);
  const resumeTemplates = Array.isArray(payload.resumeTemplates) && payload.resumeTemplates.length
    ? payload.resumeTemplates
    : [selectedResumeTemplate || "resume.tex"];

  return (
    <>
      <div className="details-header-row">
        <Link className="link-btn" to="/jobs">&lt; Back</Link>
        <div className="details-top-actions">
          <button className="btn-ghost" onClick={loadJob}>Refresh</button>
        </div>
      </div>

      <div className="card">
        <div className="details-title-row">
          <div>
            <div className="label">Role</div>
            <div className="value">{job.title || ""}</div>
          </div>
          {job.url ? (
            <a className="link-btn" href={job.url} target="_blank" rel="noreferrer">View Job</a>
          ) : null}
        </div>
        <div className="grid">
          <div>
            <div className="label">Pay Range</div>
            <div className="value">{job.compensation || "Not listed"}</div>
          </div>
          <div>
            <div className="label">Company</div>
            <div className="value">{job.company || ""}</div>
          </div>
          <div>
            <div className="label">Location</div>
            <div className="value">{job.location || ""}</div>
          </div>
          {hasResume ? (
            <div>
              <div className="label">Resume</div>
              <div className="muted">{resumeGeneratedAt ? `Last generated: ${new Date(resumeGeneratedAt * 1000).toLocaleString()}` : "Generated"}</div>
            </div>
          ) : null}
          {hasCoverLetter ? (
            <div>
              <div className="label">Cover Letter</div>
              <div className="muted">{coverGeneratedAt ? `Last generated: ${new Date(coverGeneratedAt * 1000).toLocaleString()}` : "Generated"}</div>
            </div>
          ) : null}
        </div>

        {hasAnyGeneratedArtifact ? (
          <div className="row action-row">
            {hasResume ? (
              <button className="btn-ghost" onClick={() => window.open(resumeUrl, "_blank")}>View Resume</button>
            ) : null}
            {hasCoverLetter ? (
              <button className="btn-ghost" onClick={() => window.open(coverLetterUrl, "_blank")}>View Cover Letter</button>
            ) : null}
          </div>
        ) : null}
        {hasCoverLetter && organizationMission ? (
          <div style={{ marginTop: 12 }}>
            <div className="label">Organization Mission</div>
            <div className="muted">{organizationMission}</div>
          </div>
        ) : null}

        {canGenerateForUser ? (
          <div className="buttons">
            <div>
              <div className="label">Resume Template</div>
              <select value={selectedResumeTemplate} onChange={(e) => setSelectedResumeTemplate(e.target.value)}>
                {resumeTemplates.map((template) => (
                  <option key={template} value={template}>{template}</option>
                ))}
              </select>
            </div>
            <button className="btn-primary" disabled={generatingResume} onClick={generateResume}>Generate Resume</button>
            <button className="btn-primary" disabled={generatingCover} onClick={generateCover}>Generate Coverletter</button>
          </div>
        ) : (
          <div className="muted">Resume and cover letter templates are not configured for this account.</div>
        )}
      </div>

      {hasAnyGeneratedArtifact ? (
        <div className="card">
          <div className="section-title">Changes</div>
          <div className="label">Added Skills</div>
          {renderList(augment.added_skills || [])}
          <div className="label" style={{ marginTop: 10 }}>Added Bullets</div>
          {renderList(augment.added_bullets || [])}
        </div>
      ) : null}

      <div className="card">
        <div className="section-title">JD Skills</div>
        <div className="label">Matched in Resume</div>
        {renderList(summary.matched_in_resume || [])}
        {hasResume ? (
          <>
            <div className="label" style={{ marginTop: 10 }}>Could Not Be Added</div>
            {renderList(summary.not_added || [])}
          </>
        ) : null}
      </div>

      <div className="card">
        <div className="label">Job Description</div>
        <pre>{payload.description || ""}</pre>
      </div>
    </>
  );
}

function HomeRedirect({ hasSession }) {
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const requestedJobId = getQueryParam(searchParams, "jobId", { allowGlobal: true });
  const requestedJdUrl = getQueryParam(searchParams, "jdUrl", { allowGlobal: true }) || getQueryParam(searchParams, "jd_url", { allowGlobal: true });

  if (!hasSession) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  if (requestedJobId) {
    const nextParams = new URLSearchParams();
    if (requestedJdUrl) nextParams.set("jdUrl", requestedJdUrl);
    const suffix = nextParams.toString() ? `?${nextParams.toString()}` : "";
    return <Navigate to={`/jobs/${encodeURIComponent(requestedJobId)}${suffix}`} replace />;
  }
  return <Navigate to="/jobs" replace />;
}

function App() {
  const [config, setConfig] = useState(null);
  const [initError, setInitError] = useState("");
  const [status, setStatusState] = useState({ text: "Loading...", isError: false });
  const [currentUser, setCurrentUser] = useState({ username: "", isAdmin: false });
  const navigate = useNavigate();

  const setStatus = useCallback((text, isError = false) => setStatusState({ text, isError }), []);

  useEffect(() => {
    let cancelled = false;
    loadConfig()
      .then((cfg) => {
        if (!cancelled) {
          setConfig(cfg);
          setStatus("Ready", false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setInitError(String(err));
          setStatus(`Initialization failed (${err})`, true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const auth = usePortalAuth(config || { apiBase: "", cognitoRegion: "", cognitoClientId: "" });

  useEffect(() => {
    let cancelled = false;
    const loadCurrentUser = async () => {
      if (!auth.hasSession) {
        if (!cancelled) setCurrentUser({ username: "", isAdmin: false });
        return;
      }
      try {
        const res = await auth.apiFetch("/user/settings");
        if (!res.ok) return;
        const payload = await res.json();
        if (cancelled) return;
        setCurrentUser({
          username: String(payload.username || "").toLowerCase(),
          isAdmin: Boolean(payload.isAdmin),
        });
      } catch (_err) {
        if (!cancelled) setCurrentUser({ username: "", isAdmin: false });
      }
    };
    loadCurrentUser();
    return () => { cancelled = true; };
  }, [auth.hasSession, auth.apiFetch]);

  const onLogout = () => {
    auth.clearSession();
    setCurrentUser({ username: "", isAdmin: false });
    setStatus("Signed out.", false);
    navigate("/login");
  };

  if (initError) {
    return (
      <div className="wrap">
        <h1>PingedIn Portal</h1>
        <div className="card"><div className="error">{initError}</div></div>
      </div>
    );
  }

  if (!config) {
    return (
      <div className="wrap">
        <h1>PingedIn Portal</h1>
        <div className="card"><div>Loading...</div></div>
      </div>
    );
  }

  return (
    <div className="wrap">
      <Header hasSession={auth.hasSession} onLogout={onLogout} isAdmin={currentUser.isAdmin} />
      {status.isError && status.text ? (
        <div className="card status-card">
          <div className="error">{status.text}</div>
        </div>
      ) : null}

      <Routes>
        <Route path="/" element={<HomeRedirect hasSession={auth.hasSession} />} />
        <Route path="/login" element={<LoginPage auth={auth} setStatus={setStatus} />} />
        <Route
          path="/jobs"
          element={
            <ProtectedRoute hasSession={auth.hasSession}>
              <JobsPage auth={auth} setStatus={setStatus} />
            </ProtectedRoute>
          }
        />
        <Route
          path="/filters"
          element={
            <ProtectedRoute hasSession={auth.hasSession}>
              <FiltersPage auth={auth} setStatus={setStatus} />
            </ProtectedRoute>
          }
        />
        <Route
          path="/jobs/:jobId"
          element={
            <ProtectedRoute hasSession={auth.hasSession}>
              <JobDetailsPage auth={auth} setStatus={setStatus} />
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin"
          element={
            <ProtectedRoute hasSession={auth.hasSession}>
              <AdminPage auth={auth} setStatus={setStatus} isAdmin={currentUser.isAdmin} />
            </ProtectedRoute>
          }
        />
        <Route path="*" element={<Navigate to={auth.hasSession ? "/jobs" : "/login"} replace />} />
      </Routes>
    </div>
  );
}


export default App;
