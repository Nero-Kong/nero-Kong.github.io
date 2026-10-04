(() => {
  if (window.portfolioAnalyticsLoaded) return;
  window.portfolioAnalyticsLoaded = true;
  const endpoint = window.PORTFOLIO_ANALYTICS?.endpoint;
  let enabled = false;
  try {
    enabled = Boolean(endpoint && new URL(endpoint).protocol === "https:");
  } catch (_) {}
  let sent = false;

  function report() {
    if (!enabled || sent) return;
    if (location.protocol !== "https:" || location.hostname !== "nero-kong.github.io") return;
    sent = true;
    let referrerHost = "";
    try {
      const referrer = new URL(document.referrer);
      if (referrer.hostname !== location.hostname) referrerHost = referrer.hostname;
    } catch (_) {}
    fetch(new URL("/collect", endpoint), {
      method: "POST",
      mode: "cors",
      credentials: "omit",
      keepalive: true,
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body: JSON.stringify({
        eventId: crypto.randomUUID(),
        path: location.pathname,
        referrerHost
      })
    }).catch(() => {});
  }

  report();
})();
