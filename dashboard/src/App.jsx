import { useEffect, useState } from "react";
import "./App.css";
import { db, auth } from "./firebase";
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
} from "firebase/auth";
import {
  collection,
  onSnapshot,
  query,
  orderBy,
  limit,
} from "firebase/firestore";

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || "http://localhost:8001";

function App() {
  // Authentication State
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState("");

  // Navigation State: 'dashboard' | 'live'
  const [activeTab, setActiveTab] = useState("dashboard");

  // Dashboard Overview State
  const [mode, setMode] = useState("helmet");
  const [firebaseStatus, setFirebaseStatus] = useState("Checking...");
  const [incidentCount, setIncidentCount] = useState(null);
  const [incidents, setIncidents] = useState([]);
  const [errorMessage, setErrorMessage] = useState("");

  // Live Monitoring State
  const [backendOnline, setBackendOnline] = useState(false);
  const [monitoringRunning, setMonitoringRunning] = useState(false);
  const [safetyStatus, setSafetyStatus] = useState("OFFLINE");
  const [violationsCount, setViolationsCount] = useState(0);
  const [hardhatCount, setHardhatCount] = useState(0);
  const [latestDetection, setLatestDetection] = useState(null);
  const [totalEventsLogged, setTotalEventsLogged] = useState(0);
  const [fps, setFps] = useState(0);
  const [selectedSource, setSelectedSource] = useState("helmet.mp4");
  const [availableSources, setAvailableSources] = useState([
    {
      id: "helmet.mp4",
      name: "helmet.mp4 (Compliant Scenario)",
      type: "video",
    },
    {
      id: "no_helmet.mp4",
      name: "no_helmet.mp4 (Violation Scenario)",
      type: "video",
    },
    {
      id: "android_camera",
      name: "Android Camera",
      type: "phone",
    },
    {
      id: "webcam",
      name: "Live Camera (Webcam 0)",
      type: "camera",
    },
  ]);
  const [streamKey, setStreamKey] = useState(Date.now());
  const [actionLoading, setActionLoading] = useState(false);
  const [feedback, setFeedback] = useState(null);

  // Monitor Auth State
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      setAuthLoading(false);
    });

    return unsubscribe;
  }, []);

  // Real-time Firestore Incident Listener (Preserved)
  useEffect(() => {
    if (!user) {
      setIncidents([]);
      setIncidentCount(null);
      setFirebaseStatus("Not signed in");
      setErrorMessage("");
      return;
    }

    setFirebaseStatus("Connecting...");
    setErrorMessage("");

    const incidentsQuery = query(
      collection(db, "safety_events"),
      orderBy("timestamp", "desc"),
      limit(10)
    );

    const unsubscribe = onSnapshot(
      incidentsQuery,
      (snapshot) => {
        const records = snapshot.docs.map((doc) => ({
          id: doc.id,
          ...doc.data(),
        }));

        setIncidents(records);
        setIncidentCount(records.length);
        setFirebaseStatus("Connected");
        setErrorMessage("");
      },
      (error) => {
        console.error("Firestore listener error:", error);
        setFirebaseStatus("Connection failed");
        setErrorMessage(
          error.code === "permission-denied"
            ? "Access denied. Check your Firestore security rules."
            : error.message
        );
      }
    );

    return unsubscribe;
  }, [user]);

  // Poll Backend Monitoring Status
  useEffect(() => {
    if (!user) return;

    let isMounted = true;

    async function checkStatus() {
      try {
        const res = await fetch(`${BACKEND_URL}/api/monitor/status`);
        if (!res.ok) throw new Error("Backend response error");
        const data = await res.json();

        if (!isMounted) return;

        setBackendOnline(true);
        setMonitoringRunning(data.is_monitoring);
        setSafetyStatus(data.safety_status || "OFFLINE");
        setViolationsCount(data.violations_count || 0);
        setHardhatCount(data.hardhat_count || 0);
        setLatestDetection(data.latest_detection);
        setTotalEventsLogged(data.total_events_logged || 0);
        setFps(data.fps || 0);
        // Only sync source from backend if actively monitoring to prevent snapping back in standby
        if (data.is_monitoring && data.source) {
          setSelectedSource(data.source);
        }
      } catch {
        if (!isMounted) return;
        setBackendOnline(false);
        setMonitoringRunning(false);
        setSafetyStatus("OFFLINE");
      }
    }

    checkStatus();
    const interval = setInterval(checkStatus, 1500);

    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [user]);

  // Load available sources from backend
  useEffect(() => {
    if (!user) return;
    fetch(`${BACKEND_URL}/api/monitor/sources`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data && data.sources) {
          setAvailableSources(data.sources);
        }
      })
      .catch(() => {});
  }, [user]);

  // Action Handlers
  async function handleStartMonitoring(sourceToUse = selectedSource) {
    setActionLoading(true);
    setFeedback(null);
    try {
      const res = await fetch(`${BACKEND_URL}/api/monitor/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: sourceToUse }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.detail || "Failed to start monitoring engine.");
      }

      setMonitoringRunning(true);
      setSelectedSource(sourceToUse);
      setStreamKey(Date.now());
      setFeedback({
        type: "success",
        text: `Live monitoring active on ${sourceToUse}.`,
      });
    } catch (err) {
      setFeedback({
        type: "error",
        text: err.message || "Failed to start monitoring. Check backend terminal.",
      });
    } finally {
      setActionLoading(false);
    }
  }

  async function handleStopMonitoring() {
    setActionLoading(true);
    setFeedback(null);
    try {
      const res = await fetch(`${BACKEND_URL}/api/monitor/stop`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.detail || "Failed to stop monitoring engine.");
      }

      setMonitoringRunning(false);
      setSafetyStatus("OFFLINE");
      setStreamKey(Date.now());
      setFeedback({
        type: "success",
        text: "Video monitoring stopped and camera/video resources released.",
      });
    } catch (err) {
      setFeedback({
        type: "error",
        text: err.message || "Failed to stop monitoring.",
      });
    } finally {
      setActionLoading(false);
    }
  }

  async function handleSelectSource(sourceId) {
    setSelectedSource(sourceId);
    if (monitoringRunning) {
      await handleStartMonitoring(sourceId);
    } else {
      // Notify backend of source selection so it stays in sync even while in standby
      fetch(`${BACKEND_URL}/api/monitor/source`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: sourceId }),
      }).catch(() => {});
    }
  }

  async function handleLogin(event) {
    event.preventDefault();
    setLoginError("");
    setLoginLoading(true);

    try {
      await signInWithEmailAndPassword(auth, email.trim(), password);
      setPassword("");
    } catch (error) {
      console.error("Login error:", error);
      setLoginError(
        error.code === "auth/invalid-credential"
          ? "Incorrect email or password."
          : error.code === "auth/too-many-requests"
            ? "Too many attempts. Please try again later."
            : error.message
      );
    } finally {
      setLoginLoading(false);
    }
  }

  async function handleLogout() {
    await signOut(auth);
    setEmail("");
    setPassword("");
  }

  const formatTimestamp = (timestamp) => {
    if (!timestamp) return "Time unavailable";

    const date =
      typeof timestamp.toDate === "function"
        ? timestamp.toDate()
        : new Date(timestamp);

    if (Number.isNaN(date.getTime())) return "Time unavailable";

    return date.toLocaleString();
  };

  // Auth loading screen
  if (authLoading) {
    return (
      <div className="auth-screen">
        <div className="login-card">
          <div className="brand-icon">S</div>
          <h1>SiteGuard</h1>
          <p>Checking your sign-in status...</p>
        </div>
      </div>
    );
  }

  // Login screen
  if (!user) {
    return (
      <div className="auth-screen">
        <form className="login-card" onSubmit={handleLogin}>
          <div className="brand-icon">S</div>
          <p className="eyebrow">CONSTRUCTION SAFETY PLATFORM</p>
          <h1>Welcome back</h1>
          <p className="login-description">
            Sign in to access the SiteGuard safety dashboard.
          </p>

          <label htmlFor="email">Email address</label>
          <input
            id="email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@example.com"
            autoComplete="username"
            required
          />

          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Enter your password"
            autoComplete="current-password"
            required
          />

          {loginError && (
            <p className="login-error" role="alert">
              {loginError}
            </p>
          )}

          <button
            className="login-button"
            type="submit"
            disabled={loginLoading}
          >
            {loginLoading ? "Signing in..." : "Sign in"}
          </button>

          <p className="login-footnote">
            Authorized users only
          </p>
        </form>
      </div>
    );
  }

  return (
    <div className="app">
      {/* Sidebar Navigation */}
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-icon">S</div>
          <div>
            <h2>SiteGuard</h2>
            <p>Safety Intelligence</p>
          </div>
        </div>

        <div className="nav-label">WORKSPACE</div>
        <button
          className={`nav-item ${activeTab === "dashboard" ? "active" : ""}`}
          type="button"
          onClick={() => setActiveTab("dashboard")}
        >
          ▦ Dashboard
        </button>
        <button
          className={`nav-item ${activeTab === "live" ? "active" : ""}`}
          type="button"
          onClick={() => setActiveTab("live")}
        >
          ◉ Live Monitoring
        </button>
        <button
          className="nav-item"
          type="button"
          onClick={() => setActiveTab("dashboard")}
        >
          ▤ Incident Reports
        </button>
        <button
          className="nav-item"
          type="button"
          onClick={() => setActiveTab("dashboard")}
        >
          ⚙ Settings
        </button>

        <div
          className="sidebar-footer"
          style={{ flexDirection: "column", alignItems: "flex-start", gap: "8px" }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "9px" }}>
            <div
              className="status-dot"
              style={{
                background:
                  firebaseStatus === "Connected"
                    ? "#22b573"
                    : firebaseStatus === "Connection failed"
                      ? "#e05252"
                      : "#e6a23c",
              }}
            />
            <span>Firestore: {firebaseStatus}</span>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "9px" }}>
            <div
              className="status-dot"
              style={{
                background: backendOnline ? "#22b573" : "#e05252",
              }}
            />
            <span>AI Backend: {backendOnline ? "Online" : "Offline"}</span>
          </div>
        </div>
      </aside>

      {/* Main Content Area */}
      <main className="main">
        {/* Topbar */}
        <header className="topbar">
          <div>
            <p className="eyebrow">CONSTRUCTION SAFETY PLATFORM</p>
            <h1>{activeTab === "live" ? "Live Monitoring" : "Dashboard"}</h1>
          </div>

          <div className="profile">
            <div className="avatar">A</div>
            <div>
              <strong>{user.email}</strong>
              <p>Authenticated user</p>
            </div>
            <button
              className="logout-button"
              type="button"
              onClick={handleLogout}
            >
              Sign out
            </button>
          </div>
        </header>

        {/* FEEDBACK TOAST BANNER */}
        {feedback && (
          <div className={`toast-feedback ${feedback.type}`}>
            <span>
              {feedback.type === "success" ? "✓" : "⚠️"} {feedback.text}
            </span>
            <button
              type="button"
              onClick={() => setFeedback(null)}
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                color: "inherit",
                fontWeight: "bold",
              }}
            >
              ×
            </button>
          </div>
        )}

        {/* ========================================================
            TAB 1: LIVE MONITORING PAGE
           ======================================================== */}
        {activeTab === "live" && (
          <>
            {/* Live Subheader */}
            <section className="welcome" style={{ marginBottom: "24px" }}>
              <div>
                <p className="eyebrow light">AI COMPUTER VISION PIPELINE</p>
                <h2>Real-Time PPE Detection Stream</h2>
                <p>
                  Active YOLOv11 inspection analyzing worker safety equipment,
                  detecting missing hardhats, and synchronizing incidents with Firestore.
                </p>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "8px", alignItems: "flex-end" }}>
                <span className={`system-pill ${backendOnline ? "online" : "offline"}`}>
                  <span className="system-pill-dot" />
                  FastAPI Backend: {backendOnline ? "Online (Port 8000)" : "Disconnected"}
                </span>
                <span className="system-pill">
                  Model: best.pt · Conf: 0.25
                </span>
              </div>
            </section>

            {/* Live Grid: Video Stream + Telemetry Panel */}
            <div className="live-grid">
              {/* Left Column: Video Player & Controls */}
              <div className="video-card">
                <div className="video-header">
                  <div>
                    <h2>Annotated Video Feed</h2>
                    <p>Live OpenCV stream displaying model bounding boxes and class confidence.</p>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <span className="mode-count" style={{ fontSize: "11px" }}>
                      SOURCE: {selectedSource === "android_camera" ? "Android Camera" : selectedSource}
                    </span>
                    {monitoringRunning ? (
                      <span className="system-pill online" style={{ fontWeight: 600 }}>
                        <span className="live-pulsing-dot" /> LIVE ({fps} FPS)
                      </span>
                    ) : (
                      <span className="system-pill">
                        <span className="standby-dot" /> STANDBY
                      </span>
                    )}
                  </div>
                </div>

                {/* Video Screen Box */}
                <div className="stream-display-box">
                  {!backendOnline ? (
                    <div className="stream-overlay-card">
                      <div style={{ fontSize: "36px", marginBottom: "12px" }}>⚠️</div>
                      <h3>FastAPI Backend Disconnected</h3>
                      <p>
                        The computer vision backend is not reachable at <code>{BACKEND_URL}</code>.
                        Ensure the Python server is running in your terminal:
                      </p>
                      <code>
                        source .venv/bin/activate
                        <br />
                        python backend/main.py
                      </code>
                      <button
                        className="btn-start"
                        type="button"
                        onClick={() => window.location.reload()}
                        style={{ margin: "0 auto" }}
                      >
                        Check Connection
                      </button>
                    </div>
                  ) : (
                    <>
                      <img
                        key={streamKey}
                        src={`${BACKEND_URL}/api/monitor/stream?t=${streamKey}`}
                        alt="SiteGuard AI Video Stream"
                        className="stream-image"
                        onError={() => setBackendOnline(false)}
                      />
                      <div className="stream-badge">
                        {monitoringRunning ? (
                          <>
                            <span className="live-pulsing-dot" />
                            <span>LIVE INFERENCE</span>
                          </>
                        ) : (
                          <>
                            <span className="standby-dot" />
                            <span>ENGINE STANDBY</span>
                          </>
                        )}
                      </div>
                    </>
                  )}
                </div>

                {/* Stream Controls Toolbar */}
                <div className="controls-toolbar">
                  {/* Row 1: Source selector */}
                  <div className="toolbar-row">
                    <span className="toolbar-label">SELECT INPUT SOURCE</span>
                    <div className="source-btn-group">
                      {availableSources.map((src) => (
                        <button
                          key={src.id}
                          type="button"
                          className={`source-btn ${selectedSource === src.id ? "active" : ""}`}
                          onClick={() => handleSelectSource(src.id)}
                          disabled={actionLoading || !backendOnline}
                          title={src.description || src.name}
                        >
                          {src.type === "phone" ? "📱 " : src.type === "camera" ? "📷 " : "🎬 "}
                          {src.id === "android_camera" ? "Android Camera" : src.name || src.id}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Row 2: Actions */}
                  <div className="toolbar-row" style={{ borderTop: "1px solid #ebedf3", paddingTop: "12px" }}>
                    <div style={{ display: "flex", gap: "10px" }}>
                      {!monitoringRunning ? (
                        <button
                          className="btn-start"
                          type="button"
                          onClick={() => handleStartMonitoring()}
                          disabled={actionLoading || !backendOnline}
                        >
                          {actionLoading ? "Starting Engine..." : "▶ Start Live Monitoring"}
                        </button>
                      ) : (
                        <button
                          className="btn-stop"
                          type="button"
                          onClick={handleStopMonitoring}
                          disabled={actionLoading}
                        >
                          {actionLoading ? "Stopping..." : "■ Stop Monitoring"}
                        </button>
                      )}
                    </div>

                    <span style={{ fontSize: "11px", color: "#7b8190" }}>
                      {monitoringRunning
                        ? "Continuous video loop active with YOLO frame evaluation."
                        : "Ready to monitor. Click 'Start Live Monitoring' to begin."}
                    </span>
                  </div>
                </div>
              </div>

              {/* Right Column: Real-Time Telemetry & Safety Badges */}
              <div className="telemetry-column">
                {/* Status Badge Card */}
                <div className="telemetry-card">
                  <span className="toolbar-label">SAFETY COMPLIANCE STATUS</span>

                  <div
                    className={`safety-status-box ${
                      safetyStatus === "VIOLATION DETECTED"
                        ? "violation"
                        : safetyStatus === "SAFE"
                          ? "safe"
                          : safetyStatus === "NO DETECTIONS"
                            ? "scanning"
                            : "offline"
                    }`}
                  >
                    <div className="safety-badge-header">
                      <span style={{ fontSize: "20px" }}>
                        {safetyStatus === "VIOLATION DETECTED"
                          ? "🚨"
                          : safetyStatus === "SAFE"
                            ? "🛡️"
                            : safetyStatus === "NO DETECTIONS"
                              ? "👁️"
                              : "⏸️"}
                      </span>
                      <h3 className="safety-badge-title">{safetyStatus}</h3>
                    </div>
                    <p className="safety-badge-desc">
                      {safetyStatus === "VIOLATION DETECTED"
                        ? `${violationsCount} worker(s) detected without protective hardhat!`
                        : safetyStatus === "SAFE"
                          ? "All detected site personnel are wearing protective hardhats."
                          : safetyStatus === "NO DETECTIONS"
                            ? "AI vision active. No workers or equipment detected in view."
                            : "Monitoring engine is in standby. Click Start Monitoring."}
                    </p>
                  </div>

                  {/* Telemetry Metrics */}
                  <div className="metric-grid">
                    <div className={`metric-item ${violationsCount > 0 ? "violation" : ""}`}>
                      <p>Active Violations</p>
                      <strong>{violationsCount}</strong>
                    </div>

                    <div className={`metric-item ${hardhatCount > 0 ? "safe" : ""}`}>
                      <p>Compliant Hardhats</p>
                      <strong>{hardhatCount}</strong>
                    </div>

                    <div className="metric-item">
                      <p>Stream FPS</p>
                      <strong>{fps > 0 ? fps : "--"}</strong>
                    </div>

                    <div className="metric-item">
                      <p>Firestore Events</p>
                      <strong>{totalEventsLogged}</strong>
                    </div>
                  </div>
                </div>

                {/* Latest Model Detection Card */}
                <div className="telemetry-card">
                  <span className="toolbar-label">LATEST MODEL INFERENCE</span>

                  {latestDetection ? (
                    <div style={{ marginTop: "12px" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <div>
                          <strong style={{ fontSize: "15px" }}>{latestDetection.class_name}</strong>
                          <p style={{ margin: "2px 0 0", fontSize: "11px", color: "#7b8190" }}>
                            Class ID: {latestDetection.class_id}
                          </p>
                        </div>
                        <span
                          className={`system-pill ${
                            latestDetection.class_id === 2 ? "offline" : "online"
                          }`}
                        >
                          {Math.round(latestDetection.confidence * 100)}% Match
                        </span>
                      </div>

                      <div className="confidence-bar-bg">
                        <div
                          className={`confidence-bar-fill ${
                            latestDetection.class_id === 2 ? "red" : "green"
                          }`}
                          style={{ width: `${Math.round(latestDetection.confidence * 100)}%` }}
                        />
                      </div>

                      <p style={{ marginTop: "10px", fontSize: "11px", color: "#9ca3af" }}>
                        Logged: {formatTimestamp(latestDetection.timestamp)}
                      </p>
                    </div>
                  ) : (
                    <p style={{ marginTop: "12px", fontSize: "12px", color: "#7b8190" }}>
                      No detections evaluated yet. Start monitoring to run inference.
                    </p>
                  )}
                </div>

                {/* Firestore Throttling Telemetry Card */}
                <div className="telemetry-card">
                  <span className="toolbar-label">AUTOMATED INCIDENT LOGGING</span>
                  <div style={{ display: "flex", alignItems: "center", gap: "10px", marginTop: "12px" }}>
                    <div
                      className="status-dot"
                      style={{ background: firebaseStatus === "Connected" ? "#22b573" : "#e05252" }}
                    />
                    <div>
                      <strong style={{ fontSize: "13px" }}>Firestore Live Sync</strong>
                      <p style={{ margin: "3px 0 0", fontSize: "11px", color: "#7b8190" }}>
                        10s cooldown throttle enabled to prevent duplicate events.
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Real-Time Incidents Section (Live Feed below stream) */}
            <section className="activity" style={{ marginTop: "24px" }}>
              <div>
                <h2>Live Incident Log (Firestore)</h2>
                <p>Real-time stream of security and PPE violation events from Firestore collection.</p>
              </div>
              <span className="pending-tag">
                {incidents.length} RECORDS LOADED
              </span>
            </section>

            {incidents.map((incident) => (
              <article className="incident-row" key={incident.id}>
                <div>
                  <strong>
                    {incident.status || incident.event_type || "Safety event"}
                  </strong>
                  <p>
                    Mode: {incident.mode || "helmet_check"} · Source:{" "}
                    {incident.source || incident.video || "Unknown"}
                    {incident.confidence ? ` · Confidence: ${(incident.confidence * 100).toFixed(0)}%` : ""}
                  </p>
                  <span className="stat-note">
                    {formatTimestamp(incident.timestamp)}
                  </span>
                </div>
                <span
                  className="pending-tag"
                  style={{
                    background: incident.status === "NO-Hardhat" ? "#fee2e2" : "#fef3c7",
                    color: incident.status === "NO-Hardhat" ? "#b91c1c" : "#92400e",
                  }}
                >
                  {incident.status === "NO-Hardhat" ? "VIOLATION" : incident.event_type || "EVENT"}
                </span>
              </article>
            ))}

            {incidents.length === 0 && (
              <section className="activity" style={{ marginTop: "12px" }}>
                <p>No safety incidents recorded yet. Violations detected by the backend will appear here live.</p>
              </section>
            )}
          </>
        )}

        {/* ========================================================
            TAB 2: DASHBOARD OVERVIEW PAGE (Preserved)
           ======================================================== */}
        {activeTab === "dashboard" && (
          <>
            <section className="welcome">
              <div>
                <p className="eyebrow light">SAFETY OVERVIEW</p>
                <h2>Protect every worker.</h2>
                <p>
                  Monitor protective equipment and restricted areas
                  from one intelligent safety dashboard.
                </p>
              </div>
              <div className="welcome-icon">⌁</div>
            </section>

            <section className="stats">
              <div className="stat-card">
                <span className="stat-icon purple">◉</span>
                <p>Monitoring Mode</p>
                <h3>
                  {mode === "helmet" ? "PPE Detection" : "Restricted Area"}
                </h3>
                <span className="stat-note">Selected mode</span>
              </div>

              <div className="stat-card">
                <span className="stat-icon green">✓</span>
                <p>Firebase Status</p>
                <h3>{firebaseStatus}</h3>
                <span className="stat-note">Authenticated connection</span>
              </div>

              <div className="stat-card">
                <span className="stat-icon orange">!</span>
                <p>Recent Incidents</p>
                <h3>{incidentCount === null ? "--" : incidentCount}</h3>
                <span className="stat-note">Latest 10 records queried</span>
              </div>
            </section>

            {errorMessage && (
              <section className="activity">
                <div>
                  <h2>Unable to load incidents</h2>
                  <p>{errorMessage}</p>
                </div>
              </section>
            )}

            <section className="section">
              <div className="section-heading">
                <div>
                  <h2>Choose monitoring mode</h2>
                  <p>Select the safety system you want to configure.</p>
                </div>
                <span className="mode-count">02 MODES</span>
              </div>

              <div className="mode-grid">
                <button
                  className={`mode-card ${mode === "helmet" ? "selected" : ""}`}
                  onClick={() => {
                    setMode("helmet");
                    setActiveTab("live");
                  }}
                  type="button"
                >
                  <div className="mode-icon helmet-icon">⬡</div>
                  <div className="mode-title">
                    <h3>Helmet &amp; PPE Detection</h3>
                    <span>LAUNCH MONITOR →</span>
                  </div>
                  <p>
                    Detect missing hardhats and other protective equipment
                    using an AI vision model.
                  </p>
                  <div className="mode-bottom">
                    <span>YOLO · Computer Vision</span>
                    <span>Click to Open Live Feed →</span>
                  </div>
                </button>

                <button
                  className={`mode-card ${mode === "restricted" ? "selected" : ""}`}
                  onClick={() => setMode("restricted")}
                  type="button"
                >
                  <div className="mode-icon area-icon">⌗</div>
                  <div className="mode-title">
                    <h3>Restricted Area Monitoring</h3>
                    <span>
                      {mode === "restricted" ? "SELECTED" : "SELECT MODE"}
                    </span>
                  </div>
                  <p>
                    Identify people entering a user-defined restricted
                    zone and flag potential safety violations.
                  </p>
                  <div className="mode-bottom">
                    <span>Person Detection · Zone Tracking</span>
                    <span>→</span>
                  </div>
                </button>
              </div>
            </section>

            <section className="activity">
              <div>
                <h2>Recent safety incidents</h2>
                <p>Latest records from Firestore.</p>
              </div>
              <span className="pending-tag">
                {firebaseStatus === "Connected"
                  ? `${incidents.length} LOADED`
                  : firebaseStatus.toUpperCase()}
              </span>
            </section>

            {incidents.map((incident) => (
              <article className="incident-row" key={incident.id}>
                <div>
                  <strong>
                    {incident.status || incident.event_type || "Safety event"}
                  </strong>
                  <p>
                    Mode: {incident.mode || "Unknown"} · Source:{" "}
                    {incident.source || incident.video || "Unknown"}
                  </p>
                  <span className="stat-note">
                    {formatTimestamp(incident.timestamp)}
                  </span>
                </div>
                <span className="pending-tag">
                  {incident.event_type || "EVENT"}
                </span>
              </article>
            ))}

            {firebaseStatus === "Connected" && incidents.length === 0 && (
              <section className="activity">
                <p>No safety incidents have been recorded yet.</p>
              </section>
            )}
          </>
        )}

        <footer>SiteGuard © 2026 · AI-powered construction safety</footer>
      </main>
    </div>
  );
}

export default App;
