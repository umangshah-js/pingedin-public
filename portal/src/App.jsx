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
    <header className="bg-zinc-800 border-b border-zinc-700 rounded-2xl p-5 shadow-xl flex items-start justify-between gap-3 mt-1 mb-6">
      <div>
        <h1>PingedIn Portal</h1>
      </div>
      {hasSession ? (
        <div className="flex flex-wrap gap-2.5 min-w-0 justify-end">
          <Link className="inline-flex items-center justify-center px-3 py-2 border border-zinc-700 bg-transparent text-zinc-300 no-underline hover:border-zinc-600 hover:text-zinc-200 rounded-xl font-semibold text-sm" to="/jobs">Jobs</Link>
          <Link className="inline-flex items-center justify-center px-3 py-2 border border-zinc-700 bg-transparent text-zinc-300 no-underline hover:border-zinc-600 hover:text-zinc-200 rounded-xl font-semibold text-sm" to="/filters">Preferences</Link>
          {isAdmin ? <Link className="inline-flex items-center justify-center px-3 py-2 border border-zinc-700 bg-transparent text-zinc-300 no-underline hover:border-zinc-600 hover:text-zinc-200 rounded-xl font-semibold text-sm" to="/admin">Admin</Link> : null}
          <button className="bg-transparent border border-zinc-700 text-zinc-300 hover:border-zinc-600 hover:text-zinc-200 rounded-xl font-semibold text-sm px-4 py-2.5 border border-transparent cursor-pointer hover:-translate-y-0.5 transition-all duration-150" onClick={onLogout}>Sign Out</button>
        </div>
      ) : null}
    </header>
  );
}

function InlineLoader({ label = "Loading..." }) {
  return (
    <div className="min-h-32 flex flex-col gap-2.5 items-center justify-center">
      <div className="w-7 h-7 rounded-full border-4 border-amber-500/25 border-t-amber-500 animate-spin" />
      <div className="text-zinc-400">{label}</div>
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
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3.5">
      <div className="bg-zinc-800 border border-zinc-700 rounded-2xl p-5 shadow-xl min-h-56">
        <div className="m-0 mb-1.5 text-xs font-bold text-amber-500 uppercase tracking-widest">Welcome</div>
        <h2 className="m-0 mt-1 mb-2 text-xl sm:text-2xl leading-tight">Track jobs, tailor applications, and move quickly.</h2>
        <p className="text-zinc-400">Sign in to access saved listings, resume generation, and cover letter actions.</p>
      </div>
      <div className="bg-zinc-800 border border-zinc-700 rounded-2xl p-5 shadow-xl">
        <div className="m-0 mb-1.5 text-xs font-bold text-amber-500 uppercase tracking-widest">Sign In</div>
        <form onSubmit={onSubmit}>
          <div className="grid gap-2.5">
            <div>
              <div className="text-zinc-400 text-xs mb-1">Username</div>
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                disabled={submitting}
              />
            </div>
            <div>
              <div className="text-zinc-400 text-xs mb-1">Password</div>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                disabled={submitting}
              />
            </div>
          </div>
          <div className="grid gap-2.5 grid-cols-1 mt-3">
            <button className="bg-amber-500 hover:bg-amber-400 text-zinc-900 font-bold rounded-xl font-semibold text-sm px-4 py-2.5 border border-transparent cursor-pointer hover:-translate-y-0.5 transition-all duration-150" type="submit" disabled={submitting || !username || !password}>
              Sign In
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

const DEFAULT_RECRUITER_TEMPLATE = "";

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
    linkedInUrl: "",
    portfolioUrl: "",
    recruiterMessageTemplate: DEFAULT_RECRUITER_TEMPLATE,
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");
  const [changingPassword, setChangingPassword] = useState(false);

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
          linkedInUrl: next.linkedInUrl || "",
          portfolioUrl: next.portfolioUrl || "",
          recruiterMessageTemplate: next.recruiterMessageTemplate || DEFAULT_RECRUITER_TEMPLATE,
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
          scheduleEnabled: true,
          scheduleTimezone: settings.scheduleTimezone.trim(),
          scheduleStart: settings.scheduleStart,
          scheduleEnd: settings.scheduleEnd,
          linkedInUrl: settings.linkedInUrl.trim(),
          portfolioUrl: settings.portfolioUrl.trim(),
          recruiterMessageTemplate: settings.recruiterMessageTemplate,
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

  const changePassword = async () => {
    const current = currentPassword;
    const next = newPassword;
    const confirm = confirmNewPassword;
    if (!current || !next || !confirm) {
      setStatus("Please fill current password, new password, and confirmation.", true);
      return;
    }
    if (next !== confirm) {
      setStatus("New password and confirmation do not match.", true);
      return;
    }
    if (current === next) {
      setStatus("New password must be different from current password.", true);
      return;
    }
    setChangingPassword(true);
    setStatus("Changing password...", false);
    try {
      const res = await auth.apiFetch("/user/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentPassword: current,
          newPassword: next,
        }),
      });
      if (!res.ok) {
        setStatus(`Failed to change password (${res.status}) ${await res.text()}`, true);
        return;
      }
      setCurrentPassword("");
      setNewPassword("");
      setConfirmNewPassword("");
      setStatus("Password changed.", false);
    } catch (err) {
      setStatus(`Failed to change password (${err})`, true);
    } finally {
      setChangingPassword(false);
    }
  };

  return (
    <div className="bg-zinc-800 border border-zinc-700 rounded-2xl p-5 shadow-xl">
      <div className="m-0 mb-1.5 text-xs font-bold text-amber-500 uppercase tracking-widest">Preferences</div>
      {loading ? <div className="text-zinc-400 mt-2">Loading...</div> : null}
      {!loading ? (
        <>
          <div className="m-0 mb-1.5 text-xs font-bold text-amber-500 uppercase tracking-widest mt-4">JOB ALERTS</div>
          <div className="grid gap-2.5 grid-cols-1 sm:grid-cols-2 mt-1.5">
            <div>
              <div className="text-zinc-400 text-xs mb-1">Roles / Keywords</div>
              <textarea
                rows={3}
                value={settings.keywords}
                onChange={(e) => onChange("keywords", e.target.value)}
                placeholder={"Data Engineer\nSoftware Engineer\nML Engineer"}
              />
              <div className="text-zinc-400 text-xs">Split roles by new lines only.</div>
            </div>
            <div>
              <div className="text-zinc-400 text-xs mb-1">Location</div>
              <input value={settings.location} onChange={(e) => onChange("location", e.target.value)} />
            </div>
          </div>
          <label className="flex items-center gap-2 mt-3 text-sm text-zinc-50 w-fit">
            <input type="checkbox" checked={settings.enabled} onChange={(e) => onChange("enabled", e.target.checked)} />
            <span>Receive job alerts</span>
          </label>
          <div className="grid gap-2.5 grid-cols-1 sm:grid-cols-2 mt-2">
            <div>
              <div className="text-zinc-400 text-xs mb-1">Timezone (IANA)</div>
              <select value={settings.scheduleTimezone} onChange={(e) => onChange("scheduleTimezone", e.target.value)}>
                {commonTimezones.map((tz) => (
                  <option key={tz} value={tz}>{tz}</option>
                ))}
              </select>
            </div>
            <div>
              <div className="text-zinc-400 text-xs mb-1">Active Hours</div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                <input type="time" value={settings.scheduleStart} onChange={(e) => onChange("scheduleStart", e.target.value)} />
                <input type="time" value={settings.scheduleEnd} onChange={(e) => onChange("scheduleEnd", e.target.value)} />
              </div>
              <div className="text-zinc-400 text-xs mt-1">
                Current: {(() => {
                  const duration = scheduleDurationMinutes();
                  if (duration === null) return "invalid";
                  const h = Math.floor(duration / 60);
                  const m = duration % 60;
                  return `${h}h ${m}m`;
                })()}
              </div>
            </div>
          </div>

          <hr className="border-zinc-700 my-5 mx-0" />
          <div className="m-0 mb-1.5 text-xs font-bold text-zinc-400 uppercase tracking-widest">PROFILE</div>
          <div className="grid gap-2.5 grid-cols-1 sm:grid-cols-2 mt-1.5">
            <div>
              <div className="text-zinc-400 text-xs mb-1">LinkedIn Profile URL</div>
              <input
                value={settings.linkedInUrl}
                onChange={(e) => onChange("linkedInUrl", e.target.value)}
                placeholder="https://www.linkedin.com/in/your-profile"
              />
            </div>
            <div>
              <div className="text-zinc-400 text-xs mb-1">Portfolio URL</div>
              <input
                value={settings.portfolioUrl}
                onChange={(e) => onChange("portfolioUrl", e.target.value)}
                placeholder="https://yourportfolio.com"
              />
            </div>
          </div>

          <hr className="border-zinc-700 my-5 mx-0" />
          <div className="m-0 mb-1.5 text-xs font-bold text-zinc-400 uppercase tracking-widest">RECRUITER MESSAGE</div>
          <div className="text-zinc-400 text-xs mt-1 mb-1.5">Use <code>{"{company_name}"}</code> and <code>{"{position}"}</code> as placeholders.</div>
          <textarea
            rows={12}
            value={settings.recruiterMessageTemplate}
            onChange={(e) => onChange("recruiterMessageTemplate", e.target.value)}
          />

          <div className="mt-4">
            <button className="bg-amber-500 hover:bg-amber-400 text-zinc-900 font-bold rounded-xl font-semibold text-sm px-4 py-2.5 border border-transparent cursor-pointer hover:-translate-y-0.5 transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed" disabled={saving} onClick={saveSettings}>Save Preferences</button>
          </div>
          <hr className="border-zinc-700 my-5 mx-0" />
          <div className="mt-4">
            <div className="m-0 mb-1.5 text-xs font-bold text-amber-500 uppercase tracking-widest">Change Password</div>
            <div className="text-zinc-400 text-xs">Use your current password to set a new one.</div>
            <div className="grid gap-2.5 grid-cols-1 sm:grid-cols-2 mt-2">
              <div>
                <div className="text-zinc-400 text-xs mb-1">Current Password</div>
                <input
                  type="password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  autoComplete="current-password"
                  disabled={changingPassword}
                />
              </div>
              <div>
                <div className="text-zinc-400 text-xs mb-1">New Password</div>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  autoComplete="new-password"
                  disabled={changingPassword}
                />
              </div>
              <div>
                <div className="text-zinc-400 text-xs mb-1">Confirm New Password</div>
                <input
                  type="password"
                  value={confirmNewPassword}
                  onChange={(e) => setConfirmNewPassword(e.target.value)}
                  autoComplete="new-password"
                  disabled={changingPassword}
                />
              </div>
            </div>
            <div className="grid gap-2.5 grid-cols-1 mt-3">
              <button
                className="bg-amber-500 hover:bg-amber-400 text-zinc-900 font-bold rounded-xl font-semibold text-sm px-4 py-2.5 border border-transparent cursor-pointer hover:-translate-y-0.5 transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={changingPassword || !currentPassword || !newPassword || !confirmNewPassword}
                onClick={changePassword}
              >
                {changingPassword ? "Changing..." : "Change Password"}
              </button>
            </div>
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
  const [cursorStack, setCursorStack] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [jobSearchInput, setJobSearchInput] = useState("");
  const [jobSearchQuery, setJobSearchQuery] = useState("");
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

  const commitSearch = () => {
    setJobSearchQuery(jobSearchInput.trim());
    setCursorStack([]);
  };

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const query = new URLSearchParams();
        query.set("pageSize", String(pageSize));
        const currentCursor = cursorStack.length > 0 ? cursorStack[cursorStack.length - 1] : null;
        if (currentCursor) query.set("cursor", currentCursor);
        if (jobSearchQuery) query.set("q", jobSearchQuery);
        const res = await auth.apiFetch(`/list?${query.toString()}`);
        if (!res.ok) {
          setStatus(`Failed to load jobs (${res.status}) ${await res.text()}`, true);
          return;
        }
        const data = await res.json();
        if (!cancelled) {
          setJobs(data.items || []);
          setNextCursor(data.nextCursor || null);
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
  }, [cursorStack, jobSearchQuery, auth.apiFetch, setStatus]);

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
    return <div className="bg-zinc-800 border border-zinc-700 rounded-2xl p-5 shadow-xl"><InlineLoader label="Loading jobs..." /></div>;
  }

  return (
      <div className="bg-zinc-800 border border-zinc-700 rounded-2xl p-5 shadow-xl">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2.5 mb-2">
          <div>
            <div className="m-0 mb-1.5 text-xs font-bold text-amber-500 uppercase tracking-widest">Recent Jobs</div>
            <div className="text-zinc-400">Sorted by newest seen first</div>
          </div>
          <div className="inline-flex items-center justify-center px-2.5 py-1.5 rounded-full border border-zinc-600 bg-zinc-700/50 text-xs font-semibold text-zinc-300">Page {cursorStack.length + 1}</div>
        </div>
        <div className="text-zinc-400 text-xs mb-1">Search Jobs</div>
        <div className="flex flex-col sm:flex-row gap-2 items-stretch sm:items-center">
          <input
            value={jobSearchInput}
            onChange={(e) => setJobSearchInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") commitSearch(); }}
            placeholder="Search by title, company, location, compensation, or job ID"
            className="flex-1"
          />
          <button className="bg-amber-500 hover:bg-amber-400 text-zinc-900 font-bold rounded-xl font-semibold text-sm px-4 py-2.5 border border-transparent cursor-pointer hover:-translate-y-0.5 transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap" onClick={commitSearch}>
            Search
          </button>
          <button
            className="bg-transparent border border-zinc-700 text-zinc-300 hover:border-zinc-600 hover:text-zinc-200 rounded-xl font-semibold text-sm px-4 py-2.5 border border-transparent cursor-pointer hover:-translate-y-0.5 transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
            disabled={!jobSearchInput.trim() && !jobSearchQuery}
            onClick={() => {
              setJobSearchInput("");
              setJobSearchQuery("");
              setCursorStack([]);
            }}
          >
            Clear
          </button>
        </div>
        {jobSearchQuery ? <div className="text-zinc-400 text-xs mt-2">Searching for "{jobSearchQuery}"</div> : null}
        <div className="text-zinc-400 text-xs mb-1 mt-3">Add Job by URL</div>
        <div className="flex flex-col sm:flex-row gap-2 items-stretch sm:items-center">
          <input
            value={newJobUrl}
            onChange={(e) => setNewJobUrl(e.target.value)}
            placeholder="https://www.linkedin.com/jobs/view/..."
            className="flex-1"
          />
          <button className="bg-amber-500 hover:bg-amber-400 text-zinc-900 font-bold rounded-xl font-semibold text-sm px-4 py-2.5 border border-transparent cursor-pointer hover:-translate-y-0.5 transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap" disabled={addingJob || !newJobUrl.trim()} onClick={addJobByUrl}>
            {addingJob ? "Adding..." : "Add Job"}
          </button>
        </div>
        <div className="text-zinc-400 text-xs mt-1">Add a job link to your list and open its details.</div>
        {jobs.length === 0 ? (
          <div className="text-zinc-400 mt-2">
            {jobSearchQuery ? "No jobs matched your search." : "No jobs found for this account."}
          </div>
        ) : null}
        {jobs.map((item) => (
          <div className="bg-zinc-800 border border-zinc-700 rounded-2xl p-3.5 mt-2.5 hover:border-zinc-600 transition-colors" key={item.jobId}>
            <div className="text-base leading-relaxed"><strong>{item.title || "Untitled"}</strong></div>
            <div className="text-zinc-400">{item.company || ""} • {item.location || ""}{item.compensation ? ` • ${item.compensation}` : ""}</div>
            <div className="text-zinc-400 text-xs mt-1">{item.resumePdfUploaded ? "✓ Resume ready" : "⊘ Resume not generated"}</div>
            <div className="text-zinc-400 text-xs">{item.coverLetterPdfUploaded ? "✓ Cover letter ready" : "⊘ Cover letter not generated"}</div>
            <div className="mt-2">
              <Link className="inline-flex items-center justify-center px-3 py-2 border border-zinc-700 bg-transparent text-zinc-300 no-underline hover:border-zinc-600 hover:text-zinc-200 rounded-xl font-semibold text-sm" to={`/jobs/${encodeURIComponent(item.jobId)}`}>Open Details</Link>
            </div>
          </div>
        ))}
        {!jobSearchQuery && (
          <div className="grid gap-2.5 grid-cols-2 mt-3">
            <button className="bg-transparent border border-zinc-700 text-zinc-300 hover:border-zinc-600 hover:text-zinc-200 rounded-xl font-semibold text-sm px-4 py-2.5 border border-transparent cursor-pointer hover:-translate-y-0.5 transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed" disabled={cursorStack.length === 0} onClick={() => setCursorStack((s) => s.slice(0, -1))}>Previous</button>
            <button className="bg-transparent border border-zinc-700 text-zinc-300 hover:border-zinc-600 hover:text-zinc-200 rounded-xl font-semibold text-sm px-4 py-2.5 border border-transparent cursor-pointer hover:-translate-y-0.5 transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed" disabled={!nextCursor} onClick={() => setCursorStack((s) => [...s, nextCursor])}>Next</button>
          </div>
        )}
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
      <div className="bg-zinc-800 border border-zinc-700 rounded-2xl p-5 shadow-xl mb-6">
        <div className="m-0 mb-1.5 text-xs font-bold text-amber-500 uppercase tracking-widest">Admin</div>
        <div className="text-zinc-400 text-xs">Manage users and test notifications/runs.</div>
        <div className="grid gap-2.5 grid-cols-1 mt-3">
          <button className="bg-transparent border border-zinc-700 text-zinc-300 hover:border-zinc-600 hover:text-zinc-200 rounded-xl font-semibold text-sm px-4 py-2.5 border border-transparent cursor-pointer hover:-translate-y-0.5 transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed" onClick={loadUsers} disabled={loading}>
            {loading ? "Refreshing..." : "Refresh Users"}
          </button>
        </div>
      </div>

      <div className="bg-zinc-800 border border-zinc-700 rounded-2xl p-5 shadow-xl mb-6">
        <div className="m-0 mb-1.5 text-xs font-bold text-amber-500 uppercase tracking-widest">Create User</div>
        <div className="grid gap-2.5 grid-cols-1 sm:grid-cols-2 mt-1.5">
          <div>
            <div className="text-zinc-400 text-xs mb-1">Username</div>
            <input value={username} onChange={(e) => setUsername(e.target.value)} />
          </div>
          <div>
            <div className="text-zinc-400 text-xs mb-1">Password</div>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
        </div>
        <div className="grid gap-2.5 grid-cols-1 mt-3">
          <button className="bg-amber-500 hover:bg-amber-400 text-zinc-900 font-bold rounded-xl font-semibold text-sm px-4 py-2.5 border border-transparent cursor-pointer hover:-translate-y-0.5 transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed" onClick={createUser} disabled={!username.trim() || !password}>Create User</button>
        </div>
      </div>

      <div className="bg-zinc-800 border border-zinc-700 rounded-2xl p-5 shadow-xl mb-6">
        <div className="m-0 mb-1.5 text-xs font-bold text-amber-500 uppercase tracking-widest">Update User Token</div>
        <div className="grid gap-2.5 grid-cols-1 sm:grid-cols-2 mt-1.5">
          <div>
            <div className="text-zinc-400 text-xs mb-1">Username</div>
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
            <div className="text-zinc-400 text-xs mb-1">Notification User Key</div>
            <input value={notificationUserKey} onChange={(e) => setNotificationUserKey(e.target.value)} />
          </div>
        </div>
        <div className="grid gap-2.5 grid-cols-1 mt-3">
          <button className="bg-amber-500 hover:bg-amber-400 text-zinc-900 font-bold rounded-xl font-semibold text-sm px-4 py-2.5 border border-transparent cursor-pointer hover:-translate-y-0.5 transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed" onClick={updateToken} disabled={!tokenUsername}>Update Token</button>
        </div>
      </div>

      <div className="bg-zinc-800 border border-zinc-700 rounded-2xl p-5 shadow-xl mb-6">
        <div className="m-0 mb-1.5 text-xs font-bold text-amber-500 uppercase tracking-widest">Test Notification</div>
        <div className="grid gap-2.5 grid-cols-1 sm:grid-cols-2 mt-1.5">
          <div>
            <div className="text-zinc-400 text-xs mb-1">Username</div>
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
            <div className="text-zinc-400 text-xs mb-1">Message</div>
            <input value={testMessage} onChange={(e) => setTestMessage(e.target.value)} />
          </div>
        </div>
        <div className="grid gap-2.5 grid-cols-1 mt-3">
          <button className="bg-amber-500 hover:bg-amber-400 text-zinc-900 font-bold rounded-xl font-semibold text-sm px-4 py-2.5 border border-transparent cursor-pointer hover:-translate-y-0.5 transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed" onClick={sendTestNotification} disabled={!testUsername}>Send Test Notification</button>
        </div>
      </div>

      <div className="bg-zinc-800 border border-zinc-700 rounded-2xl p-5 shadow-xl">
        <div className="m-0 mb-1.5 text-xs font-bold text-amber-500 uppercase tracking-widest">Trigger Test Lambda Run</div>
        <div className="grid gap-2.5 grid-cols-1 sm:grid-cols-2 mt-1.5">
          <div>
            <div className="text-zinc-400 text-xs mb-1">Username (optional)</div>
            <input
              value={runUsername}
              onChange={(e) => setRunUsername(e.target.value)}
              placeholder="Leave blank to run all enabled users"
            />
          </div>
          <div>
            <div className="text-zinc-400 text-xs mb-1">force_tpr</div>
            <input value={forceTpr} onChange={(e) => setForceTpr(e.target.value)} />
          </div>
        </div>
        <div className="grid gap-2.5 grid-cols-1 mt-3">
          <button className="bg-amber-500 hover:bg-amber-400 text-zinc-900 font-bold rounded-xl font-semibold text-sm px-4 py-2.5 border border-transparent cursor-pointer hover:-translate-y-0.5 transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed" onClick={triggerTestRun}>Trigger Test Run</button>
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
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleInput, setTitleInput] = useState("");
  const [savingTitle, setSavingTitle] = useState(false);
  const [editingCompany, setEditingCompany] = useState(false);
  const [companyInput, setCompanyInput] = useState("");
  const [savingCompany, setSavingCompany] = useState(false);

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
  const linkedInUrl = payload?.linkedInUrl || "";
  const portfolioUrl = payload?.portfolioUrl || "";

  const applyToJob = async () => {
    const parts = [portfolioUrl, linkedInUrl].filter(Boolean);
    for (const url of parts) {
      try { await navigator.clipboard.writeText(url); } catch (_) {}
      await new Promise((r) => setTimeout(r, 100));
    }
    if (job.url) window.open(job.url, "_blank");
  };
  const coverLetterText = payload?.coverLetterText || "";
  const [copyingCoverLetter, setCopyingCoverLetter] = useState(false);

  const copyCoverLetterText = async () => {
    if (!coverLetterText) return;
    setCopyingCoverLetter(true);
    try {
      await navigator.clipboard.writeText(coverLetterText);
      setStatus("Cover letter text copied to clipboard.", false);
    } catch (err) {
      setStatus(`Failed to copy cover letter text: ${err}`, true);
    } finally {
      setCopyingCoverLetter(false);
    }
  };

  const copyRecruiterMessage = async () => {
    const template = payload?.recruiterMessageTemplate || DEFAULT_RECRUITER_TEMPLATE;
    const message = template
      .replace(/\{company_name\}/g, job.company || "")
      .replace(/\{position\}/g, job.title || "");
    try {
      await navigator.clipboard.writeText(message);
      setStatus("Recruiter message copied to clipboard.", false);
    } catch (err) {
      setStatus(`Failed to copy message: ${err}`, true);
    }
  };

  const saveCompany = async () => {
    setSavingCompany(true);
    try {
      const res = await auth.apiFetch(`/job/update?jobId=${encodeURIComponent(jobId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ company: companyInput.trim() }),
      });
      if (!res.ok) {
        setStatus(`Failed to update company (${res.status})`, true);
        return;
      }
      setEditingCompany(false);
      await loadJob();
      setStatus("Company name updated.", false);
    } catch (err) {
      setStatus(`Failed to update company: ${err}`, true);
    } finally {
      setSavingCompany(false);
    }
  };

  const saveTitle = async () => {
    setSavingTitle(true);
    try {
      const res = await auth.apiFetch(`/job/update?jobId=${encodeURIComponent(jobId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: titleInput.trim() }),
      });
      if (!res.ok) {
        setStatus(`Failed to update role (${res.status})`, true);
        return;
      }
      setEditingTitle(false);
      await loadJob();
      setStatus("Role updated.", false);
    } catch (err) {
      setStatus(`Failed to update role: ${err}`, true);
    } finally {
      setSavingTitle(false);
    }
  };

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
    return <div className="bg-zinc-800 border border-zinc-700 rounded-2xl p-5 shadow-xl"><InlineLoader label="Loading job..." /></div>;
  }

  if (!payload) {
    return <div className="bg-zinc-800 border border-zinc-700 rounded-2xl p-5 shadow-xl"><div className="text-red-400">Job not found.</div></div>;
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
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2.5 mt-1 mb-6">
        <Link className="inline-flex items-center justify-center px-3 py-2 border border-zinc-700 bg-transparent text-zinc-300 no-underline hover:border-zinc-600 hover:text-zinc-200 rounded-xl font-semibold text-sm" to="/jobs">&lt; Back</Link>
        <div className="flex justify-end sm:justify-end items-center gap-2.5">
          <button className="bg-transparent border border-zinc-700 text-zinc-300 hover:border-zinc-600 hover:text-zinc-200 rounded-xl font-semibold text-sm px-4 py-2.5 border border-transparent cursor-pointer hover:-translate-y-0.5 transition-all duration-150" onClick={loadJob}>Refresh</button>
        </div>
      </div>

      <div className="bg-zinc-800 border border-zinc-700 rounded-2xl p-5 shadow-xl mb-6">
        <div className="grid gap-2.5 grid-cols-1 sm:grid-cols-2 mb-6">
          <div>
            <div className="text-zinc-400 text-xs mb-1">Role</div>
            {editingTitle ? (
              <div className="flex gap-1.5 items-center mt-1">
                <input
                  className="w-auto flex-1"
                  style={{ padding: "6px 10px", fontSize: "14px" }}
                  value={titleInput}
                  onChange={(e) => setTitleInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") saveTitle(); if (e.key === "Escape") setEditingTitle(false); }}
                  autoFocus
                />
                <button className="bg-amber-500 hover:bg-amber-400 text-zinc-900 font-bold px-2 py-1.5 text-xs rounded-xl disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap" disabled={savingTitle || !titleInput.trim()} onClick={saveTitle}>Save</button>
                <button className="bg-transparent border border-zinc-700 text-zinc-300 hover:border-zinc-600 px-2 py-1.5 text-xs rounded-xl" onClick={() => setEditingTitle(false)}>Cancel</button>
              </div>
            ) : (
              <div className="flex gap-2 items-center">
                <div className="text-base leading-relaxed">{job.title || ""}</div>
                <button className="bg-transparent border border-zinc-700 text-zinc-300 hover:border-zinc-600 px-2 py-1 text-xs rounded-lg" onClick={() => { setTitleInput(job.title || ""); setEditingTitle(true); }}>Edit</button>
              </div>
            )}
          </div>
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-start gap-3">
            <div className="flex-1">
              <div className="text-zinc-400 text-xs mb-1">Company</div>
              {editingCompany ? (
                <div className="flex gap-1.5 items-center mt-1">
                  <input
                    className="w-auto flex-1"
                    style={{ padding: "6px 10px", fontSize: "14px" }}
                    value={companyInput}
                    onChange={(e) => setCompanyInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") saveCompany(); if (e.key === "Escape") setEditingCompany(false); }}
                    autoFocus
                  />
                  <button className="bg-amber-500 hover:bg-amber-400 text-zinc-900 font-bold px-2 py-1.5 text-xs rounded-xl disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap" disabled={savingCompany || !companyInput.trim()} onClick={saveCompany}>Save</button>
                  <button className="bg-transparent border border-zinc-700 text-zinc-300 hover:border-zinc-600 px-2 py-1.5 text-xs rounded-xl" onClick={() => setEditingCompany(false)}>Cancel</button>
                </div>
              ) : (
                <div className="flex gap-2 items-center">
                  <div className="text-base leading-relaxed">{job.company || ""}</div>
                  <button className="bg-transparent border border-zinc-700 text-zinc-300 hover:border-zinc-600 px-2 py-1 text-xs rounded-lg" onClick={() => { setCompanyInput(job.company || ""); setEditingCompany(true); }}>Edit</button>
                </div>
              )}
            </div>
            {job.url ? (
              <button className="bg-amber-500 hover:bg-amber-400 text-zinc-900 font-bold rounded-xl font-semibold text-sm px-4 py-2.5 border border-transparent cursor-pointer hover:-translate-y-0.5 transition-all duration-150 min-w-fit whitespace-nowrap" onClick={applyToJob}>Apply</button>
            ) : null}
          </div>
        </div>
        <div className="grid gap-2.5 grid-cols-1 sm:grid-cols-2 mb-6">
          <div>
            <div className="text-zinc-400 text-xs mb-1">Pay Range</div>
            <div className="text-base leading-relaxed">{job.compensation || "Not listed"}</div>
          </div>
          <div>
            <div className="text-zinc-400 text-xs mb-1">Location</div>
            <div className="text-base leading-relaxed">{job.location || ""}</div>
          </div>
        </div>

        {hasAnyGeneratedArtifact ? (
          <div className="flex flex-wrap gap-2.5 mt-3">
            {hasResume ? (
              <button className="bg-transparent border border-zinc-700 text-zinc-300 hover:border-zinc-600 hover:text-zinc-200 rounded-xl font-semibold text-sm px-4 py-2.5 border border-transparent cursor-pointer hover:-translate-y-0.5 transition-all duration-150" onClick={() => window.open(resumeUrl, "_blank")}>View Resume</button>
            ) : null}
            {hasCoverLetter ? (
              <button className="bg-transparent border border-zinc-700 text-zinc-300 hover:border-zinc-600 hover:text-zinc-200 rounded-xl font-semibold text-sm px-4 py-2.5 border border-transparent cursor-pointer hover:-translate-y-0.5 transition-all duration-150" onClick={() => window.open(coverLetterUrl, "_blank")}>View Cover Letter</button>
            ) : null}
            {hasCoverLetter && coverLetterText ? (
              <button className="bg-transparent border border-zinc-700 text-zinc-300 hover:border-zinc-600 hover:text-zinc-200 rounded-xl font-semibold text-sm px-4 py-2.5 border border-transparent cursor-pointer hover:-translate-y-0.5 transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed" disabled={copyingCoverLetter} onClick={copyCoverLetterText}>
                {copyingCoverLetter ? "Copying..." : "Copy Cover Letter Text"}
              </button>
            ) : null}
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2.5 mt-3">
          {payload?.recruiterMessageTemplate ? (
            <button className="bg-transparent border border-zinc-700 text-zinc-300 hover:border-zinc-600 hover:text-zinc-200 rounded-xl font-semibold text-sm px-4 py-2.5 border border-transparent cursor-pointer hover:-translate-y-0.5 transition-all duration-150" onClick={copyRecruiterMessage}>Copy Recruiter Message</button>
          ) : null}
        </div>
        {hasCoverLetter && organizationMission ? (
          <div className="mt-3">
            <div className="text-zinc-400 text-xs mb-1">Organization Mission</div>
            <div className="text-zinc-400 text-sm">{organizationMission}</div>
          </div>
        ) : null}

        {canGenerateForUser ? (
          <div className="grid gap-2.5 grid-cols-1 mt-3">
            <div>
              <div className="text-zinc-400 text-xs mb-1">Resume Template</div>
              <select value={selectedResumeTemplate} onChange={(e) => setSelectedResumeTemplate(e.target.value)}>
                {resumeTemplates.map((template) => (
                  <option key={template} value={template}>{template}</option>
                ))}
              </select>
            </div>
            <div className="grid gap-2.5 grid-cols-1 sm:grid-cols-2">
              <div>
                <button className="w-full bg-amber-500 hover:bg-amber-400 text-zinc-900 font-bold rounded-xl font-semibold text-sm px-4 py-2.5 border border-transparent cursor-pointer hover:-translate-y-0.5 transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed" disabled={generatingResume} onClick={generateResume}>Generate Resume</button>
                {hasResume ? (
                  <div className="text-zinc-400 text-xs mt-1">{resumeGeneratedAt ? `Last generated: ${new Date(resumeGeneratedAt * 1000).toLocaleString()}` : "Generated"}</div>
                ) : null}
              </div>
              <div>
                <button className="w-full bg-amber-500 hover:bg-amber-400 text-zinc-900 font-bold rounded-xl font-semibold text-sm px-4 py-2.5 border border-transparent cursor-pointer hover:-translate-y-0.5 transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed" disabled={generatingCover} onClick={generateCover}>Generate Coverletter</button>
                {hasCoverLetter ? (
                  <div className="text-zinc-400 text-xs mt-1">{coverGeneratedAt ? `Last generated: ${new Date(coverGeneratedAt * 1000).toLocaleString()}` : "Generated"}</div>
                ) : null}
              </div>
            </div>
          </div>
        ) : (
          <div className="text-zinc-400 text-xs mt-3">Resume and cover letter templates are not configured for this account.</div>
        )}
      </div>

      {hasAnyGeneratedArtifact ? (
        <div className="bg-zinc-800 border border-zinc-700 rounded-2xl p-5 shadow-xl mb-6">
          <div className="m-0 mb-1.5 text-xs font-bold text-amber-500 uppercase tracking-widest">Changes</div>
          <div className="text-zinc-400 text-xs mb-1">Added Skills</div>
          {renderList(augment.added_skills || [])}
          <div className="text-zinc-400 text-xs mb-1 mt-2.5">Added Bullets</div>
          {renderList(augment.added_bullets || [])}
        </div>
      ) : null}

      <div className="bg-zinc-800 border border-zinc-700 rounded-2xl p-5 shadow-xl mb-6">
        <div className="m-0 mb-1.5 text-xs font-bold text-amber-500 uppercase tracking-widest">JD Skills</div>
        <div className="text-zinc-400 text-xs mb-1">Matched in Resume</div>
        {renderList(summary.matched_in_resume || [])}
        {hasResume ? (
          <>
            <div className="text-zinc-400 text-xs mb-1 mt-2.5">Could Not Be Added</div>
            {renderList(summary.not_added || [])}
          </>
        ) : null}
      </div>

      <div className="bg-zinc-800 border border-zinc-700 rounded-2xl p-5 shadow-xl">
        <div className="text-zinc-400 text-xs mb-1">Job Description</div>
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
      <div className="max-w-4xl mx-auto px-4 py-8">
        <h1 className="m-0 text-2xl sm:text-3xl tracking-wide font-bold">PingedIn Portal</h1>
        <div className="bg-zinc-800 border border-zinc-700 rounded-2xl p-5 shadow-xl"><div className="text-red-400">{initError}</div></div>
      </div>
    );
  }

  if (!config) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-8">
        <h1 className="m-0 text-2xl sm:text-3xl tracking-wide font-bold">PingedIn Portal</h1>
        <div className="bg-zinc-800 border border-zinc-700 rounded-2xl p-5 shadow-xl"><div>Loading...</div></div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <Header hasSession={auth.hasSession} onLogout={onLogout} isAdmin={currentUser.isAdmin} />
      {status.isError && status.text ? (
        <div className="bg-zinc-800 border border-zinc-700 rounded-2xl p-5 shadow-xl py-3 px-4 mb-6">
          <div className="text-red-400">{status.text}</div>
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
