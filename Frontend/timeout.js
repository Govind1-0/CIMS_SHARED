(function () {
  const TIMEOUT_ADMIN = 30 * 60 * 1000;
  const TIMEOUT_HOTEL = 15 * 60 * 1000;
  const CHECK_EVERY   = 15 * 1000;      
  const KEY           = "cims_last_activity";


  const token = localStorage.getItem("cims_token");
  if (!token) return;

  const role    = localStorage.getItem("cims_role");
  const timeout = role === "admin" ? TIMEOUT_ADMIN : TIMEOUT_HOTEL;

  function tokenIssuedAt() {
    try {
      const b64 = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      return (JSON.parse(atob(b64)).iat || 0) * 1000;
    } catch { return 0; }
  }

  function lastActivity() {
    const stored = Number(localStorage.getItem(KEY)) || 0;
    return Math.max(stored, tokenIssuedAt()) || Date.now();
  }

  let loggedOut = false;
  function logoutDueToInactivity() {
    if (loggedOut) return;          
    loggedOut = true;
    localStorage.removeItem("cims_token");
    localStorage.removeItem("cims_user");
    localStorage.removeItem("cims_role");
    localStorage.removeItem(KEY);
    alert("You have been logged out due to inactivity.");
    window.location.href = "login.html";
  }

  function expired() {
    return Date.now() - lastActivity() >= timeout;
  }

  function check() {
    if (expired()) logoutDueToInactivity();
  }

  let lastWrite = 0;
  function touch() {
    const now = Date.now();
    if (expired()) { logoutDueToInactivity(); return; }
    if (now - lastWrite < 5000) return;
    lastWrite = now;
    localStorage.setItem(KEY, String(now));
  }

  ["mousedown", "mousemove", "keydown", "scroll", "touchstart", "click"].forEach(ev => {
    document.addEventListener(ev, touch, { capture: true, passive: true });
  });

  document.addEventListener("visibilitychange", () => { if (!document.hidden) check(); });

  window.addEventListener("focus", check);
  window.addEventListener("pageshow", check);

  setInterval(check, CHECK_EVERY);

  check();
  touch();
})();