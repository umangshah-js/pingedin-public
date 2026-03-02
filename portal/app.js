const { useEffect, useState } = React;
const { createRoot } = ReactDOM;
const {
  HashRouter,
  Navigate,
  Link,
  useNavigate,
  useParams,
  useSearchParams,
  useLocation,
  Routes,
  Route,
} = ReactRouterDOM;

const ACCESS_TOKEN_STORAGE_KEY = "pingedin.portal.accessToken";
const REFRESH_TOKEN_STORAGE_KEY = "pingedin.portal.refreshToken";

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

  const updateTokens = (next) => {
    const value = {
      accessToken: next?.accessToken || "",
      refreshToken: next?.refreshToken || "",
    };
    setTokens(value);
    writeTokens(value);
  };

  const clearSession = () => updateTokens({ accessToken: "", refreshToken: "" });

  const refreshAccessToken = async () => {
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
  };

  const signIn = async (username, password) => {
    const result = await cognitoInitiateAuth(config, "USER_PASSWORD_AUTH", {
      USERNAME: username,
      PASSWORD: password,
    });
    if (!result.AccessToken || !result.RefreshToken) {
      throw new Error("Authentication response missing tokens");
    }
    updateTokens({ accessToken: result.AccessToken, refreshToken: result.RefreshToken });
  };

  const apiFetch = async (path, options = {}) => {
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
  };

  return {
    hasSession,
    tokens,
    signIn,
    apiFetch,
    clearSession,
    setTokens: updateTokens,
  };
}

function ProtectedRoute({ hasSession, children }) {
  const location = useLocation();
  if (!hasSession) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  return children;
}

function Header({ hasSession, onLogout }) {
  return (
    <div>
      <h1>PingedIn Portal</h1>
      <div className="muted">Job details & on-demand resume generation</div>
      {hasSession ? (
        <div className="buttons" style={{ gridTemplateColumns: "1fr 1fr", maxWidth: 260 }}>
          <Link className="link-btn" to="/jobs">Jobs</Link>
          <button className="btn-ghost" onClick={onLogout}>Sign Out</button>
        </div>
      ) : null}
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
    <div className="card">
      <div className="section-title">Sign In</div>
      <form onSubmit={onSubmit}>
        <div className="grid" style={{ gap: 10 }}>
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
        <div className="buttons" style={{ marginTop: 12 }}>
          <button className="btn-primary" type="submit" disabled={submitting || !username || !password}>
            Sign In
          </button>
        </div>
      </form>
    </div>
  );
}

function JobsPage({ auth, setStatus }) {
  const [jobs, setJobs] = useState([]);
  const [pageIndex, setPageIndex] = useState(0);
  const pageSize = 10;

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setStatus("Loading jobs...", false);
      try {
        const res = await auth.apiFetch("/list?limit=200");
        if (!res.ok) {
          setStatus(`Failed to load jobs (${res.status}) ${await res.text()}`, true);
          return;
        }
        const data = await res.json();
        if (!cancelled) {
          setJobs(data.items || []);
          setPageIndex(0);
          setStatus("Select a job", false);
        }
      } catch (err) {
        setStatus(`Failed to load jobs (${err})`, true);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [auth, setStatus]);

  const totalPages = Math.max(1, Math.ceil(jobs.length / pageSize));
  const pageItems = jobs.slice(pageIndex * pageSize, pageIndex * pageSize + pageSize);

  return (
    <div className="card">
      <div className="section-title">Recent Jobs</div>
      {pageItems.length === 0 ? <div className="muted">No jobs found.</div> : null}
      {pageItems.map((item) => (
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
      <div className="buttons" style={{ gridTemplateColumns: "1fr 1fr", marginTop: 12 }}>
        <button className="btn-ghost" disabled={pageIndex === 0} onClick={() => setPageIndex((x) => Math.max(0, x - 1))}>Previous</button>
        <button className="btn-ghost" disabled={pageIndex + 1 >= totalPages} onClick={() => setPageIndex((x) => Math.min(totalPages - 1, x + 1))}>Next</button>
      </div>
      <div className="muted" style={{ textAlign: "center", marginTop: 8 }}>Page {pageIndex + 1} of {totalPages}</div>
    </div>
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

  const loadJob = async () => {
    setLoading(true);
    setStatus("Loading job...", false);
    try {
      const res = await auth.apiFetch(`/job?jobId=${encodeURIComponent(jobId || "")}`);
      if (!res.ok) {
        setStatus(`Failed to load job (${res.status}) ${await res.text()}`, true);
        return;
      }
      const data = await res.json();
      setPayload(data);
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

  const downloadFile = (url, filename) => {
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
  };

  if (loading) {
    return <div className="card"><div>Loading...</div></div>;
  }

  if (!payload) {
    return <div className="card"><div className="error">Job not found.</div></div>;
  }

  const job = payload.job || {};
  const augment = payload.augment || {};
  const summary = payload.summary || {};
  const resumeGeneratedAt = payload.resumeGeneratedAt || 0;
  const coverGeneratedAt = payload.coverLetterGeneratedAt || 0;

  return (
    <>
      <div className="buttons" style={{ gridTemplateColumns: "1fr", marginTop: 12 }}>
        <Link className="link-btn" to="/jobs">Back to List</Link>
      </div>

      <div className="card">
        <div className="grid">
          <div>
            <div className="label">Role</div>
            <div className="value">{job.title || ""}</div>
          </div>
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
          <div>
            <div className="label">Job Link</div>
            <div className="value"><a className="link-btn" href={job.url || "#"} target="_blank" rel="noreferrer">Open Job Posting</a></div>
          </div>
          <div>
            <div className="label">Resume</div>
            <div className="muted">{resumeGeneratedAt ? `Last generated: ${new Date(resumeGeneratedAt * 1000).toLocaleString()}` : "Not generated"}</div>
          </div>
          <div>
            <div className="label">Cover Letter</div>
            <div className="muted">{coverGeneratedAt ? `Last generated: ${new Date(coverGeneratedAt * 1000).toLocaleString()}` : "Not generated"}</div>
          </div>
        </div>

        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn-ghost" disabled={!resumeUrl} onClick={() => window.open(resumeUrl, "_blank")}>View Resume</button>
          <button className="btn-ghost" disabled={!resumeUrl} onClick={() => downloadFile(resumeUrl, "Umang Shah Resume.pdf")}>Download Resume</button>
          <button className="btn-ghost" disabled={!coverLetterUrl} onClick={() => window.open(coverLetterUrl, "_blank")}>View Coverletter</button>
          <button className="btn-ghost" disabled={!coverLetterUrl} onClick={() => downloadFile(coverLetterUrl, "Umang Shah Cover Letter.pdf")}>Download Coverletter</button>
        </div>

        <div className="buttons">
          <button className="btn-primary" disabled={generatingResume} onClick={generateResume}>Generate Resume</button>
          <button className="btn-primary" disabled={generatingCover} onClick={generateCover}>Generate Coverletter</button>
          <button className="btn-ghost" onClick={loadJob}>Refresh</button>
        </div>
      </div>

      <div className="card">
        <div className="section-title">Changes</div>
        <div className="label">Added Skills</div>
        {renderList(augment.added_skills || [])}
        <div className="label" style={{ marginTop: 10 }}>Added Bullets</div>
        {renderList(augment.added_bullets || [])}
      </div>

      <div className="card">
        <div className="section-title">JD Skills</div>
        <div className="label">Matched in Resume</div>
        {renderList(summary.matched_in_resume || [])}
        <div className="label" style={{ marginTop: 10 }}>Could Not Be Added</div>
        {renderList(summary.not_added || [])}
      </div>

      <div className="card">
        <div className="label">Job Description</div>
        <pre>{payload.description || ""}</pre>
      </div>
    </>
  );
}

function App() {
  const [config, setConfig] = useState(null);
  const [initError, setInitError] = useState("");
  const [status, setStatusState] = useState({ text: "Loading...", isError: false });
  const navigate = useNavigate();

  const setStatus = (text, isError = false) => setStatusState({ text, isError });

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

  const onLogout = () => {
    auth.clearSession();
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
      <Header hasSession={auth.hasSession} onLogout={onLogout} />
      <div className="card">
        <div className={status.isError ? "error" : ""}>{status.text}</div>
      </div>

      <Routes>
        <Route path="/" element={<Navigate to={auth.hasSession ? "/jobs" : "/login"} replace />} />
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
          path="/jobs/:jobId"
          element={
            <ProtectedRoute hasSession={auth.hasSession}>
              <JobDetailsPage auth={auth} setStatus={setStatus} />
            </ProtectedRoute>
          }
        />
        <Route path="*" element={<Navigate to={auth.hasSession ? "/jobs" : "/login"} replace />} />
      </Routes>
    </div>
  );
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </React.StrictMode>
);
