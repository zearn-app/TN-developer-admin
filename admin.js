// Waits for firebase-config.js (a module, loaded above this script) to finish
// setting up window.ADMIN before wiring up the UI.
window.addEventListener("admin-firebase-ready", initAdmin);

function initAdmin() {
  const ADMIN = window.ADMIN;

  // ============ ELEMENTS ============
  const loginScreen = document.getElementById("loginScreen");
  const shell = document.getElementById("shell");
  const loginForm = document.getElementById("loginForm");
  const loginStatus = document.getElementById("loginStatus");
  const loginBtn = document.getElementById("loginBtn");
  const whoEmail = document.getElementById("whoEmail");
  const settingsEmail = document.getElementById("settingsEmail");
  const settingsUid = document.getElementById("settingsUid");
  const settingsProjectId = document.getElementById("settingsProjectId");
  const copyUidBtn = document.getElementById("copyUidBtn");
  const logoutBtn = document.getElementById("logoutBtn");
  const errorBanner = document.getElementById("errorBanner");
  const errorBannerText = document.getElementById("errorBannerText");

  // ============ ERROR REPORTING ============
  // Turns a raw Firebase error into something that actually explains what's
  // wrong, instead of a generic "check your connection" message.
  function describeFirestoreError(err, context = "") {
    const code = err?.code || "unknown";
    const where = context ? ` (${context})` : "";
    if (code === "permission-denied") {
      return `Blocked by Firestore rules${where} [permission-denied]. Your signed-in UID isn't recognized as admin — check Settings for your real UID, and confirm it's pasted into every ADMIN_UID spot in your Firestore rules, then Publish again.`;
    }
    if (code === "unauthenticated") {
      return `Not signed in${where} [unauthenticated]. Try logging out and back in.`;
    }
    if (code === "unavailable" || code === "failed-precondition") {
      return `Can't reach Firestore${where} [${code}]. Check your internet connection.`;
    }
    if (code === "not-found") {
      return `That document doesn't exist${where} [not-found].`;
    }
    return `${err?.message || "Unknown error"}${where} [${code}]`;
  }

  function showErrorBanner(text) {
    errorBannerText.textContent = text;
    errorBanner.hidden = false;
  }
  document.getElementById("errorBannerClose").addEventListener("click", () => { errorBanner.hidden = true; });

  // ============ SETTINGS DIAGNOSTICS ============
  // Tracks read status per collection so Settings can show exactly which
  // ones are blocked, instead of a single vague error.
  const diagStatus = {
    "analytics/pageViews": "pending",
    "analytics/appDownloads": "pending",
    "hireRequests": "pending",
    "projects": "pending",
    "apps": "pending",
  };
  function renderDiagnostics() {
    const box = document.getElementById("settingsDiagnostics");
    if (!box) return;
    box.innerHTML = Object.entries(diagStatus).map(([key, status]) => `
      <div class="diag-row">
        <span class="diag-dot ${status === 'ok' ? 'ok' : status === 'pending' ? 'pending' : 'bad'}"></span>
        <span class="mono">${key}</span>
        <span style="color:var(--ink-dim);">${status === 'ok' ? 'readable' : status === 'pending' ? 'checking…' : 'blocked'}</span>
      </div>`).join("");
  }

  // ============ AUTH ============
  loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    loginStatus.textContent = "";
    loginBtn.disabled = true;
    loginBtn.textContent = "Signing in…";
    try {
      await ADMIN.login(
        document.getElementById("loginEmail").value.trim(),
        document.getElementById("loginPassword").value
      );
    } catch (err) {
      loginStatus.textContent = friendlyAuthError(err);
    } finally {
      loginBtn.disabled = false;
      loginBtn.textContent = "Sign In";
    }
  });

  function friendlyAuthError(err) {
    const code = err.code || "";
    if (code.includes("invalid-credential") || code.includes("wrong-password") || code.includes("user-not-found")) {
      return "Incorrect email or password.";
    }
    if (code.includes("too-many-requests")) return "Too many attempts — try again shortly.";
    if (code.includes("network-request-failed")) return "Network error — check your internet connection.";
    return `Couldn't sign in — ${err.message || "unknown error"} [${code || "no code"}]`;
  }

  logoutBtn.addEventListener("click", () => ADMIN.logout());



  let unsubscribers = [];
  function clearSubscriptions() {
    unsubscribers.forEach(u => u());
    unsubscribers = [];
  }

  ADMIN.onAuth((user) => {
    if (user) {
      loginScreen.hidden = true;
      shell.hidden = false;
      whoEmail.textContent = user.email;
      settingsEmail.textContent = user.email;
      settingsUid.textContent = user.uid;
      settingsProjectId.textContent = ADMIN.projectId || "—";
      errorBanner.hidden = true;
      startLiveData();
    } else {
      loginScreen.hidden = false;
      shell.hidden = true;
      clearSubscriptions();
    }
  });

  copyUidBtn.addEventListener("click", async () => {
    const uid = settingsUid.textContent;
    if (!uid || uid === "—") return;
    try {
      await navigator.clipboard.writeText(uid);
      copyUidBtn.textContent = "Copied!";
      setTimeout(() => { copyUidBtn.textContent = "Copy UID"; }, 1500);
    } catch {
      alert(uid); // clipboard blocked (common on http, non-localhost) — show it so it can be selected manually
    }
  });

  // ============ NAV / VIEW SWITCHING ============
  const sideLinks = document.querySelectorAll(".side-link[data-view]");
  function showView(name) {
    document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
    document.getElementById("view-" + name)?.classList.add("active");
    sideLinks.forEach(l => l.classList.toggle("active", l.dataset.view === name));
  }
  sideLinks.forEach(link => link.addEventListener("click", () => showView(link.dataset.view)));
  document.querySelectorAll("[data-view-link]").forEach(btn => {
    btn.addEventListener("click", () => showView(btn.dataset.viewLink));
  });

  // ============ LIVE DATA ============
  let pageViews = {};
  let appDownloads = {};
  let hireRequests = [];
  let websites = [];
  let apps = [];

  function startLiveData() {
    clearSubscriptions();

    // Any read failure here (almost always Firestore rules blocking the
    // signed-in UID) surfaces as a real banner + a per-collection status in
    // Settings, instead of the dashboard just silently showing zeros.
    function onErr(key) {
      return (err, context) => {
        diagStatus[key] = "bad";
        renderDiagnostics();
        showErrorBanner(describeFirestoreError(err, context));
      };
    }
    function markOk(key) {
      diagStatus[key] = "ok";
      renderDiagnostics();
    }

    unsubscribers.push(ADMIN.watchDoc("analytics", "pageViews", (data) => {
      pageViews = data; markOk("analytics/pageViews"); renderOverview();
    }, onErr("analytics/pageViews")));

    unsubscribers.push(ADMIN.watchDoc("analytics", "appDownloads", (data) => {
      appDownloads = data; markOk("analytics/appDownloads"); renderOverview();
    }, onErr("analytics/appDownloads")));

    unsubscribers.push(ADMIN.watchCollection("hireRequests", "createdAt", (docs) => {
      hireRequests = docs.reverse(); // newest first
      markOk("hireRequests"); renderOverview(); renderHires();
    }, "asc", onErr("hireRequests")));

    unsubscribers.push(ADMIN.watchCollection("projects", "order", (docs) => {
      websites = docs; markOk("projects"); renderWebsites(); renderOverview();
    }, "asc", onErr("projects")));

    unsubscribers.push(ADMIN.watchCollection("apps", "order", (docs) => {
      apps = docs; markOk("apps"); renderApps(); renderOverview();
    }, "asc", onErr("apps")));

    renderDiagnostics();
  }

  // ============ OVERVIEW ============
  const PAGE_LABELS = ["home", "about", "skills", "projects", "process", "testimonials", "contact"];

  function bar(label, value, max) {
    const pct = max > 0 ? Math.max(4, Math.round((value / max) * 100)) : 0;
    return `<div class="bar-row">
      <span class="bar-label">${escapeHtml(label)}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
      <span class="bar-val">${value.toLocaleString()}</span>
    </div>`;
  }

  function renderOverview() {
    document.getElementById("statTotalVisits").textContent = (pageViews.total || 0).toLocaleString();
    document.getElementById("statTotalDownloads").textContent = (appDownloads.total || 0).toLocaleString();
    document.getElementById("statTotalHires").textContent = hireRequests.length.toLocaleString();
    document.getElementById("statTotalProjects").textContent = websites.length.toLocaleString();
    document.getElementById("statTotalApps").textContent = apps.length.toLocaleString();

    const sectionVals = PAGE_LABELS.map(p => pageViews[p] || 0);
    const sectionMax = Math.max(1, ...sectionVals);
    document.getElementById("sectionBars").innerHTML = PAGE_LABELS.map((p, i) => bar(p, sectionVals[i], sectionMax)).join("")
      || `<p class="empty-note">No visit data yet.</p>`;

    const appIds = Object.keys(appDownloads).filter(k => k !== "total");
    const appVals = appIds.map(id => appDownloads[id] || 0);
    const appMax = Math.max(1, ...appVals, 0);
    document.getElementById("appBars").innerHTML = appIds.length
      ? appIds.map((id, i) => bar(id, appVals[i], appMax)).join("")
      : `<p class="empty-note">No downloads yet.</p>`;

    const recent = hireRequests.slice(0, 5);
    const tbody = document.querySelector("#recentHiresTable tbody");
    tbody.innerHTML = recent.map(rowHireBrief).join("");
    document.getElementById("recentHiresEmpty").hidden = recent.length > 0;
  }

  function rowHireBrief(h) {
    return `<tr>
      <td>${escapeHtml(h.name)}</td>
      <td>${escapeHtml(h.businessName)}</td>
      <td>${escapeHtml(h.businessEmail)}</td>
      <td>${formatDate(h.createdAt)}</td>
    </tr>`;
  }

  function formatDate(ts) {
    if (!ts) return "—";
    const d = ts.toDate ? ts.toDate() : new Date(ts);
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  function escapeHtml(str) {
    return String(str ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  // ============ HIRE REQUESTS VIEW ============
  const hirePill = document.getElementById("hirePill");

  function renderHires() {
    hirePill.hidden = hireRequests.length === 0;
    hirePill.textContent = hireRequests.length;

    const tbody = document.querySelector("#hiresTable tbody");
    tbody.innerHTML = hireRequests.map(h => `<tr>
      <td>${formatDate(h.createdAt)}</td>
      <td>${escapeHtml(h.name)}</td>
      <td>${escapeHtml(h.businessName)}</td>
      <td><a href="mailto:${escapeHtml(h.businessEmail)}">${escapeHtml(h.businessEmail)}</a></td>
      <td>${escapeHtml(h.instagram) || "—"}</td>
      <td>${escapeHtml(h.youtube) || "—"}</td>
      <td class="actions"><button class="row-btn danger" data-delete-hire="${h.id}">Delete</button></td>
    </tr>`).join("");
    document.getElementById("hiresEmpty").hidden = hireRequests.length > 0;

    tbody.querySelectorAll("[data-delete-hire]").forEach(btn => {
      btn.addEventListener("click", () => confirmDelete(
        "hireRequests", btn.dataset.deleteHire, `Delete the hire request from "${escapeHtml(hireRequests.find(h=>h.id===btn.dataset.deleteHire)?.name || '')}"?`
      ));
    });
  }

  // ============ WEBSITES VIEW ============
  function renderWebsites() {
    const tbody = document.querySelector("#websitesTable tbody");
    tbody.innerHTML = websites.map(w => `<tr>
      <td class="mono">${w.order ?? 0}</td>
      <td>${escapeHtml(w.title)}</td>
      <td style="text-transform:capitalize">${escapeHtml(w.category || 'premium')}</td>
      <td><span class="truncate">${escapeHtml(w.url || '—')}</span></td>
      <td><span class="status-dot ${w.active !== false ? 'on' : 'off'}"></span>${w.active !== false ? 'Active' : 'Hidden'}</td>
      <td class="actions">
        <button class="row-btn" data-edit-website="${w.id}">Edit</button>
        <button class="row-btn danger" data-delete-website="${w.id}">Delete</button>
      </td>
    </tr>`).join("");
    document.getElementById("websitesEmpty").hidden = websites.length > 0;

    tbody.querySelectorAll("[data-edit-website]").forEach(btn => {
      btn.addEventListener("click", () => openWebsiteModal(websites.find(w => w.id === btn.dataset.editWebsite)));
    });
    tbody.querySelectorAll("[data-delete-website]").forEach(btn => {
      const w = websites.find(x => x.id === btn.dataset.deleteWebsite);
      btn.addEventListener("click", () => confirmDelete("projects", btn.dataset.deleteWebsite, `Delete the website "${escapeHtml(w?.title || '')}"? This removes it from the live site.`));
    });
  }

  // ============ APPS VIEW ============
  function renderApps() {
    const tbody = document.querySelector("#appsTable tbody");
    tbody.innerHTML = apps.map(a => `<tr>
      <td class="mono">${a.order ?? 0}</td>
      <td>${escapeHtml(a.name)}</td>
      <td>${escapeHtml(a.badge || '—')}</td>
      <td class="mono">${(appDownloads[a.appId || a.id] || 0).toLocaleString()}</td>
      <td><span class="status-dot ${a.active !== false ? 'on' : 'off'}"></span>${a.active !== false ? 'Active' : 'Hidden'}</td>
      <td class="actions">
        <button class="row-btn" data-edit-app="${a.id}">Edit</button>
        <button class="row-btn danger" data-delete-app="${a.id}">Delete</button>
      </td>
    </tr>`).join("");
    document.getElementById("appsEmpty").hidden = apps.length > 0;

    tbody.querySelectorAll("[data-edit-app]").forEach(btn => {
      btn.addEventListener("click", () => openAppModal(apps.find(a => a.id === btn.dataset.editApp)));
    });
    tbody.querySelectorAll("[data-delete-app]").forEach(btn => {
      const a = apps.find(x => x.id === btn.dataset.deleteApp);
      btn.addEventListener("click", () => confirmDelete("apps", btn.dataset.deleteApp, `Delete the app "${escapeHtml(a?.name || '')}"? This removes it from the live site.`));
    });
  }

  // ============ WEBSITE MODAL ============
  const websiteModalOverlay = document.getElementById("websiteModalOverlay");
  const websiteForm = document.getElementById("websiteForm");
  const websiteStatus = document.getElementById("websiteStatus");
  const websiteCategory = document.getElementById("websiteCategory");
  const websitePremiumFields = document.getElementById("websitePremiumFields");
  const websiteCreativeFields = document.getElementById("websiteCreativeFields");

  document.getElementById("addWebsiteBtn").addEventListener("click", () => openWebsiteModal(null));

  websiteCategory.addEventListener("change", () => {
    const isCreative = websiteCategory.value === "creative";
    websitePremiumFields.hidden = isCreative;
    websiteCreativeFields.hidden = !isCreative;
  });

  function openWebsiteModal(w) {
    websiteForm.reset();
    websiteStatus.textContent = "";
    document.getElementById("websiteId").value = w?.id || "";
    document.getElementById("websiteModalTitle").textContent = w ? "Edit Website" : "Add Website";
    websiteCategory.value = w?.category || "premium";
    websiteCategory.dispatchEvent(new Event("change"));

    document.getElementById("websiteTitle").value = w?.category !== "creative" ? (w?.title || "") : "";
    document.getElementById("websiteUrl").value = w?.url || "";
    document.getElementById("websiteBadge").value = w?.badge || "🥇 Premium";
    document.getElementById("websiteFeatures").value = (w?.features || []).join("\n");
    document.getElementById("websiteCreativeTitle").value = w?.category === "creative" ? (w?.title || "") : "";
    document.getElementById("websiteIcon").value = w?.icon || "✨";
    document.getElementById("websiteOrder").value = w?.order ?? websites.length;
    document.getElementById("websiteActive").checked = w?.active !== false;
    websiteModalOverlay.classList.add("open");
  }

  websiteForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = document.getElementById("websiteId").value;
    const category = websiteCategory.value;
    const isCreative = category === "creative";
    const title = (isCreative ? document.getElementById("websiteCreativeTitle").value : document.getElementById("websiteTitle").value).trim();

    if (!title) {
      websiteStatus.textContent = "Title is required.";
      return;
    }

    const data = {
      category,
      title,
      order: Number(document.getElementById("websiteOrder").value) || 0,
      active: document.getElementById("websiteActive").checked,
    };
    if (isCreative) {
      data.icon = document.getElementById("websiteIcon").value.trim() || "✨";
    } else {
      data.url = document.getElementById("websiteUrl").value.trim();
      data.badge = document.getElementById("websiteBadge").value.trim() || "🥇 Premium";
      data.features = document.getElementById("websiteFeatures").value.split("\n").map(s => s.trim()).filter(Boolean);
    }

    const btn = document.getElementById("websiteSaveBtn");
    btn.disabled = true; btn.textContent = "Saving…";
    try {
      if (id) await ADMIN.update("projects", id, data);
      else await ADMIN.add("projects", data);
      closeModals();
    } catch (err) {
      websiteStatus.textContent = describeFirestoreError(err, "projects");
      console.error(err);
    } finally {
      btn.disabled = false; btn.textContent = "Save Website";
    }
  });

  // ============ APP MODAL ============
  const appModalOverlay = document.getElementById("appModalOverlay");
  const appForm = document.getElementById("appForm");
  const appStatus = document.getElementById("appStatus");
  const versionsSection = document.getElementById("versionsSection");
  let currentVersionsAppId = null;
  let currentVersions = [];
  let unsubVersions = null;

  document.getElementById("addAppBtn").addEventListener("click", () => openAppModal(null));

  function openAppModal(a) {
    appForm.reset();
    appStatus.textContent = "";
    appStatus.style.color = "";
    document.getElementById("appDocId").value = a?.id || "";
    document.getElementById("appModalTitle").textContent = a ? "Edit App" : "Add App";
    document.getElementById("appId").value = a?.appId || "";
    document.getElementById("appName").value = a?.name || "";
    document.getElementById("appTag").value = a?.tag || "";
    document.getElementById("appDesc").value = a?.desc || "";
    document.getElementById("appFeatures").value = (a?.features || []).join("\n");
    document.getElementById("appIcon").value = a?.icon || "📱";
    document.getElementById("appBadge").value = a?.badge || "Free";
    document.getElementById("appApkUrl").value = a?.apkUrl || "";
    document.getElementById("appFileName").value = a?.fileName || "";
    document.getElementById("appMeta").value = a?.meta || "Android • Direct APK install • Not on Play Store";
    document.getElementById("appOrder").value = a?.order ?? apps.length;
    document.getElementById("appActive").checked = a?.active !== false;
    appModalOverlay.classList.add("open");

    // Versions can only be managed once the app itself exists (need its id
    // to store apps/{appId}/versions/{versionId}).
    if (unsubVersions) { unsubVersions(); unsubVersions = null; }
    if (a?.id) {
      currentVersionsAppId = a.id;
      versionsSection.hidden = false;
      unsubVersions = ADMIN.watchVersions(a.id, (docs) => {
        currentVersions = docs;
        renderVersions();
      });
    } else {
      currentVersionsAppId = null;
      currentVersions = [];
      versionsSection.hidden = true;
    }
  }

    function renderVersions() {
    const tbody = document.querySelector("#versionsTable tbody");
    tbody.innerHTML = currentVersions.map(v => `<tr>
      <td class="mono">${escapeHtml(v.version)}</td>
      <td>${v.releaseDate || "—"}</td>
      <td>${v.visible ? '<span class="live-badge">Live</span>' : `<button type="button" class="row-btn set-live-btn" data-set-live="${v.id}">Set Live</button>`}</td>
      <td class="actions">
        <button type="button" class="row-btn" data-edit-version="${v.id}">Edit</button>
        <button type="button" class="row-btn danger" data-delete-version="${v.id}">Delete</button>
      </td>
    </tr>`).join("");
    document.getElementById("versionsEmpty").hidden = currentVersions.length > 0;

    tbody.querySelectorAll("[data-set-live]").forEach(btn => {
      btn.addEventListener("click", async () => {
        btn.disabled = true; btn.textContent = "Setting…";
        try { await ADMIN.setVisibleVersion(currentVersionsAppId, btn.dataset.setLive); }
        catch (err) { console.error(err); alert(describeFirestoreError(err, "apps/versions")); }
      });
    });
    tbody.querySelectorAll("[data-edit-version]").forEach(btn => {
      btn.addEventListener("click", () => openVersionModal(currentVersions.find(v => v.id === btn.dataset.editVersion)));
    });
    tbody.querySelectorAll("[data-delete-version]").forEach(btn => {
      const v = currentVersions.find(x => x.id === btn.dataset.deleteVersion);
      btn.addEventListener("click", () => confirmDelete(
        null, null,
        `Delete version "${escapeHtml(v?.version || '')}"? This can't be undone.`,
        async () => ADMIN.removeVersion(currentVersionsAppId, btn.dataset.deleteVersion)
      ));
    });
  }

  document.getElementById("addVersionBtn").addEventListener("click", () => openVersionModal(null));

  const versionModalOverlay = document.getElementById("versionModalOverlay");
  const versionForm = document.getElementById("versionForm");
  const versionStatus = document.getElementById("versionStatus");

  function openVersionModal(v) {
    versionForm.reset();
    versionStatus.textContent = "";
    document.getElementById("versionId").value = v?.id || "";
    document.getElementById("versionModalTitle").textContent = v ? "Edit Version" : "Add Version";
    document.getElementById("versionNumber").value = v?.version || "";
    document.getElementById("versionReleaseDate").value = v?.releaseDate || new Date().toISOString().slice(0, 10);
    document.getElementById("versionApkUrl").value = v?.apkUrl || "";
    document.getElementById("versionFileName").value = v?.fileName || "";
    document.getElementById("versionChangelog").value = v?.changelog || "";
    document.getElementById("versionVisible").checked = !!v?.visible;
    versionModalOverlay.classList.add("open");
  }

  versionForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!currentVersionsAppId) return;
    const id = document.getElementById("versionId").value;
    const versionNumber = document.getElementById("versionNumber").value.trim();
    const apkUrl = document.getElementById("versionApkUrl").value.trim();
    if (!versionNumber || !apkUrl) {
      versionStatus.textContent = "Version number and APK URL are required.";
      return;
    }
    const makeVisible = document.getElementById("versionVisible").checked;
    const data = {
      version: versionNumber,
      releaseDate: document.getElementById("versionReleaseDate").value,
      apkUrl,
      fileName: document.getElementById("versionFileName").value.trim() || `${versionNumber}.apk`,
      changelog: document.getElementById("versionChangelog").value.trim(),
      visible: makeVisible,
    };

    const btn = document.getElementById("versionSaveBtn");
    btn.disabled = true; btn.textContent = "Saving…";
    try {
      let savedId = id;
      if (id) await ADMIN.updateVersion(currentVersionsAppId, id, data);
      else savedId = (await ADMIN.addVersion(currentVersionsAppId, data)).id;
      if (makeVisible) await ADMIN.setVisibleVersion(currentVersionsAppId, savedId);
      versionModalOverlay.classList.remove("open"); // only close the version modal, keep the app modal open
    } catch (err) {
      versionStatus.textContent = describeFirestoreError(err, "apps/versions");
      console.error(err);
    } finally {
      btn.disabled = false; btn.textContent = "Save Version";
    }
  });

  appForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = document.getElementById("appDocId").value;
    const name = document.getElementById("appName").value.trim();
    let appId = document.getElementById("appId").value.trim();
    if (!name) { appStatus.textContent = "App name is required."; return; }
    if (!appId) appId = name.replace(/[^a-zA-Z0-9]/g, "");

    const data = {
      appId,
      name,
      tag: document.getElementById("appTag").value.trim(),
      desc: document.getElementById("appDesc").value.trim(),
      features: document.getElementById("appFeatures").value.split("\n").map(s => s.trim()).filter(Boolean),
      icon: document.getElementById("appIcon").value.trim() || "📱",
      badge: document.getElementById("appBadge").value.trim() || "Free",
      apkUrl: document.getElementById("appApkUrl").value.trim(),
      fileName: document.getElementById("appFileName").value.trim() || (name + ".apk"),
      meta: document.getElementById("appMeta").value.trim(),
      order: Number(document.getElementById("appOrder").value) || 0,
      active: document.getElementById("appActive").checked,
    };

    const btn = document.getElementById("appSaveBtn");
    btn.disabled = true; btn.textContent = "Saving…";
    try {
      if (id) {
        await ADMIN.update("apps", id, data);
        closeModals();
      } else {
        const ref = await ADMIN.add("apps", data);
        // Reopen immediately in edit mode so "Versions" unlocks right away.
        openAppModal({ id: ref.id, ...data });
        appStatus.textContent = "App created — add a version below to make it downloadable.";
        appStatus.style.color = "var(--good)";
      }
    } catch (err) {
      appStatus.textContent = describeFirestoreError(err, "apps");
      console.error(err);
    } finally {
      btn.disabled = false; btn.textContent = "Save App";
    }
  });

  // ============ CONFIRM DELETE MODAL ============
  const confirmModalOverlay = document.getElementById("confirmModalOverlay");
  const confirmModalText = document.getElementById("confirmModalText");
  const confirmDeleteBtn = document.getElementById("confirmDeleteBtn");
  let pendingDelete = null;

  // collectionName/id delete a top-level doc; pass customAction instead to
  // run an arbitrary delete (used for the apps/{id}/versions subcollection).
  function confirmDelete(collectionName, id, text, customAction = null) {
    pendingDelete = { collectionName, id, customAction };
    confirmModalText.textContent = text;
    confirmModalOverlay.classList.add("open");
  }

  confirmDeleteBtn.addEventListener("click", async () => {
    if (!pendingDelete) return;
    confirmDeleteBtn.disabled = true;
    confirmDeleteBtn.textContent = "Deleting…";
    try {
      if (pendingDelete.customAction) await pendingDelete.customAction();
      else await ADMIN.remove(pendingDelete.collectionName, pendingDelete.id);
      confirmModalOverlay.classList.remove("open"); // only close the confirm dialog, keep any modal beneath it open
    } catch (err) {
      console.error(err);
      alert(describeFirestoreError(err, pendingDelete.collectionName || "delete"));
    } finally {
      confirmDeleteBtn.disabled = false;
      confirmDeleteBtn.textContent = "Delete";
      pendingDelete = null;
    }
  });

  // ============ MODAL SHARED ============
  function closeModals() {
    document.querySelectorAll(".modal-overlay").forEach(o => o.classList.remove("open"));
    if (unsubVersions) { unsubVersions(); unsubVersions = null; }
  }
  document.querySelectorAll("[data-close-modal]").forEach(btn => btn.addEventListener("click", closeModals));
  document.querySelectorAll(".modal-overlay").forEach(overlay => {
    overlay.addEventListener("click", (e) => { if (e.target === overlay) closeModals(); });
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModals(); });
}
