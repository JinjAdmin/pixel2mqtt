"use strict";
// Help drawer: shows the editor guide exactly as it is published on GitHub (docs/GUIDE.md on main).
(() => {
  const REPO = "https://github.com/SamWiIIiams/pixel2mqtt";
  const RAW = "https://raw.githubusercontent.com/SamWiIIiams/pixel2mqtt/main/docs/";
  const PAGE = REPO + "/blob/main/docs/GUIDE.md";
  const $ = s => document.querySelector(s);
  let loaded = false;

  const esc = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  // relative links/images in GUIDE.md are relative to docs/ in the repo
  const abs = (u, img) => /^[a-z]+:|^#/i.test(u) ? u
    : img ? RAW + u.replace(/^\.\//, "")
    : new URL(u, REPO + "/blob/main/docs/").href;
  const safeUrl = u => /^(https?:|#)/i.test(u) ? u : "#";

  function inline(s) {
    const codes = [];
    s = s.replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
    s = esc(s);
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, u) => `<img alt="${alt}" src="${esc(safeUrl(abs(u, true)))}" loading="lazy">`);
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => {
      const h = safeUrl(abs(u));
      return h.startsWith("#") ? `<a href="${h}">${t}</a>` : `<a href="${esc(h)}" target="_blank" rel="noopener">${t}</a>`;
    });
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[+i])}</code>`);
  }
  const slug = t => t.toLowerCase().replace(/<[^>]+>/g, "").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-");

  function render(md) {
    const L = md.replace(/\r/g, "").split("\n"), out = [];
    let i = 0;
    const cells = r => r.trim().replace(/^\||\|$/g, "").split("|").map(c => inline(c.trim()));
    while (i < L.length) {
      const l = L[i];
      if (!l.trim()) { i++; continue; }
      let m;
      if ((m = l.match(/^(#{1,4})\s+(.*)/))) {
        const t = inline(m[2]); out.push(`<h${m[1].length} id="${slug(t)}">${t}</h${m[1].length}>`); i++; continue;
      }
      if (/^```/.test(l)) {
        const buf = []; i++;
        while (i < L.length && !/^```/.test(L[i])) buf.push(L[i++]);
        i++; out.push(`<pre><code>${esc(buf.join("\n"))}</code></pre>`); continue;
      }
      if (/^\s*\|/.test(l) && L[i + 1] && /^\s*\|?\s*:?-{2,}/.test(L[i + 1])) {
        const head = cells(l); i += 2; const rows = [];
        while (i < L.length && /^\s*\|/.test(L[i])) rows.push(cells(L[i++]));
        out.push(`<table><thead><tr>${head.map(c => `<th>${c}</th>`).join("")}</tr></thead><tbody>` +
                 rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join("")}</tr>`).join("") + "</tbody></table>");
        continue;
      }
      if ((m = l.match(/^\s*([-*]|\d+\.)\s+/))) {
        const ol = /\d/.test(m[1]), items = [];
        while (i < L.length && (m = L[i].match(/^\s*([-*]|\d+\.)\s+(.*)/))) {
          let t = m[2]; i++;
          while (i < L.length && /^\s{2,}\S/.test(L[i]) && !/^\s*([-*]|\d+\.)\s+/.test(L[i])) t += " " + L[i++].trim();
          items.push(`<li>${inline(t)}</li>`);
        }
        out.push(ol ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`); continue;
      }
      if (/^>\s?/.test(l)) {
        const buf = []; while (i < L.length && /^>\s?/.test(L[i])) buf.push(L[i++].replace(/^>\s?/, ""));
        out.push(`<blockquote>${inline(buf.join(" "))}</blockquote>`); continue;
      }
      const buf = [];
      while (i < L.length && L[i].trim() && !/^(#{1,4}\s|```|\s*\||\s*([-*]|\d+\.)\s|>)/.test(L[i])) buf.push(L[i++].trim());
      if (!buf.length) buf.push(L[i++].trim());
      out.push(`<p>${inline(buf.join(" "))}</p>`);
    }
    return out.join("\n");
  }

  async function load(force) {
    const body = $("#helpBody");
    if (loaded && !force) return;
    body.innerHTML = `<p class="muted">Loading the guide from GitHub…</p>`;
    try {
      const r = await fetch(RAW + "GUIDE.md" + (force ? "?t=" + Date.now() : ""), { cache: force ? "reload" : "default" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      body.innerHTML = render(await r.text());
      loaded = true;
    } catch (e) {
      body.innerHTML = `<p>Couldn't load the guide from GitHub (${esc(String(e.message || e))}). ` +
        `The guide needs internet access. You can also read it at <a href="${PAGE}" target="_blank" rel="noopener">github.com</a>.</p>`;
    }
  }

  function open() {
    $("#helpDrawer").classList.add("open"); $("#helpShade").classList.add("open");
    $("#helpDrawer").setAttribute("aria-hidden", "false"); load(false);
  }
  function close() {
    $("#helpDrawer").classList.remove("open"); $("#helpShade").classList.remove("open");
    $("#helpDrawer").setAttribute("aria-hidden", "true");
  }
  $("#helpBtn").addEventListener("click", () => $("#helpDrawer").classList.contains("open") ? close() : open());
  $("#helpClose").addEventListener("click", close);
  $("#helpShade").addEventListener("click", close);
  $("#helpReload").addEventListener("click", () => load(true));
  $("#helpGh").href = PAGE;
  document.addEventListener("keydown", e => { if (e.key === "Escape" && $("#helpDrawer").classList.contains("open")) close(); });
  $("#helpBody").addEventListener("click", e => {   // in-page anchors scroll inside the drawer
    const a = e.target.closest("a[href^='#']"); if (!a) return;
    e.preventDefault(); const t = document.getElementById(decodeURIComponent(a.getAttribute("href").slice(1)));
    if (t) t.scrollIntoView({ behavior: "smooth" });
  });
})();
