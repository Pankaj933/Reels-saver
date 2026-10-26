const form = document.getElementById("urlForm");
const urlInput = document.getElementById("videoUrl");
const statusBox = document.getElementById("status");
const resultBox = document.getElementById("result");
const platformName = document.getElementById("platformName");
const inspectBtn = document.getElementById("inspectBtn");
const themeToggle = document.getElementById("themeToggle");

const thumb = document.getElementById("thumb");
const titleEl = document.getElementById("title");
const qualitySel = document.getElementById("quality");
const dlUrl = document.getElementById("dlUrl");
const downloadForm = document.getElementById("downloadForm");
const downloadBtn = document.getElementById("downloadBtn");
const dlFrame = document.getElementById("dlFrame");

const themeMeta = document.querySelector('meta[name="theme-color"]');
const savedTheme = localStorage.getItem("reelsaver-theme");

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const isDark = theme === "dark";
  themeToggle.textContent = isDark ? "☀ Light mode" : "☾ Dark mode";
  themeToggle.setAttribute(
    "aria-label",
    `Switch to ${isDark ? "light" : "dark"} mode`
  );
  themeMeta.content = isDark ? "#090c12" : "#f5f7f1";
}

setTheme(savedTheme === "light" ? "light" : "dark");
themeToggle.addEventListener("click", () => {
  const theme = document.documentElement.dataset.theme === "dark"
    ? "light"
    : "dark";
  setTheme(theme);
  localStorage.setItem("reelsaver-theme", theme);
});

function setStatus(text, type = "info") {
  statusBox.textContent = text;
  statusBox.className = `status ${type}`;
}

function resetResult() {
  resultBox.hidden = true;
  thumb.hidden = true;
  thumb.removeAttribute("src");
  titleEl.textContent = "";
  qualitySel.replaceChildren();
}

// Paste button
document.getElementById("pasteBtn").addEventListener("click", async () => {
  try {
    urlInput.value = await navigator.clipboard.readText();
    urlInput.focus();
  } catch {
    setStatus("Clipboard access unavailable. URL ko manually paste karein.",
              "error");
  }
});

function formatSize(bytes) {
  if (!bytes) return "";
  if (bytes < 1024 * 1024) return `~${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `~${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `~${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function withSize(label, bytes) {
  const size = formatSize(bytes);
  return size ? `${label} (${size})` : label;
}

function addOption(value, label) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  qualitySel.appendChild(option);
}

// Step 1: URL inspect
form.addEventListener("submit", async event => {
  event.preventDefault();

  setStatus("Video info nikal rahe hain...");
  resetResult();
  inspectBtn.disabled = true;

  try {
    const response = await fetch("/api/inspect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: urlInput.value.trim() })
    });

    const payload = await response.json().catch(() => ({}));

    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || "Unable to inspect this link.");
    }

    const data = payload.data;

    if (data.platform !== "Instagram") {
      throw new Error("Please Instagram Reel ya post ka URL enter karein.");
    }

    platformName.textContent = data.platform;
    titleEl.textContent = data.title || "";
    dlUrl.value = data.url;

    if (data.thumbnail) {
      thumb.src = data.thumbnail;
      thumb.hidden = false;
    }

        qualitySel.replaceChildren();
    addOption("best", withSize("Best available", data.best_size));
    (data.qualities || []).forEach(q =>
      addOption(q.height, withSize(`${q.height}p`, q.size))
    );
    addOption("audio", withSize("Audio only", data.audio_size));

    resultBox.hidden = false;
    setStatus("Video mil gayi. Quality select karke download dabayein.", "ok");
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    inspectBtn.disabled = false;
  }
});

// Step 2: Download (normal form POST -> hidden iframe, browser file stream karta hai)
// ---------- Step 2: Download with progress popup ----------
const modal = document.getElementById("dlModal");
const modalTitle = document.getElementById("modalTitle");
const barFill = document.getElementById("barFill");
const modalPercent = document.getElementById("modalPercent");
const modalSize = document.getElementById("modalSize");
const modalNote = document.getElementById("modalNote");
const modalClose = document.getElementById("modalClose");

let controller = null;

const mb = bytes => (bytes / 1024 / 1024).toFixed(1) + " MB";

function showModal() {
  modal.hidden = false;
  modalTitle.textContent = "Preparing...";
  modalNote.textContent = "Server video prepare kar raha hai, thoda wait karein...";
  modalPercent.textContent = "";
  modalSize.textContent = "";
  barFill.className = "bar-fill indeterminate";
  barFill.style.width = "";
  modalClose.textContent = "Cancel";
}

function hideModal() {
  modal.hidden = true;
}

function getFilename(response) {
  const header = response.headers.get("Content-Disposition") || "";
  const star = header.match(/filename\*=UTF-8''([^;]+)/i);
  if (star) return decodeURIComponent(star[1]);
  const plain = header.match(/filename="?([^";]+)"?/i);
  return plain ? plain[1] : "video.mp4";
}

modalClose.addEventListener("click", () => {
  if (controller) controller.abort();
  hideModal();
});

downloadForm.addEventListener("submit", async event => {
  event.preventDefault();

  controller = new AbortController();
  downloadBtn.disabled = true;
  showModal();

  try {
    const response = await fetch("/api/download", {
      method: "POST",
      body: new URLSearchParams({
        url: dlUrl.value,
        quality: qualitySel.value
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || "Download fail ho gaya.");
    }

    // Phase 2: file browser me aa rahi hai
    const total = Number(response.headers.get("Content-Length")) || 0;
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;

    modalTitle.textContent = "Downloading...";
    modalNote.textContent = "File aapke device par aa rahi hai.";
    if (total) {
      barFill.className = "bar-fill";
      barFill.style.width = "0%";
    }

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;

      if (total) {
        const percent = Math.round((received / total) * 100);
        barFill.style.width = percent + "%";
        modalPercent.textContent = percent + "%";
        modalSize.textContent = `${mb(received)} / ${mb(total)}`;
      } else {
        modalSize.textContent = mb(received);
      }
    }

    // Save file
    const blob = new Blob(chunks, {
      type: response.headers.get("Content-Type") || "video/mp4"
    });
    const blobUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = blobUrl;
    link.download = getFilename(response);
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);

    // Done
    barFill.className = "bar-fill done";
    barFill.style.width = "100%";
    modalPercent.textContent = "100%";
    modalTitle.textContent = "Download complete ✅";
    modalNote.textContent = "Video save ho gayi. Downloads folder check karein.";
    modalClose.textContent = "Close";
    setStatus("Download ho gaya.", "ok");
  } catch (error) {
    if (error.name === "AbortError") {
      setStatus("Download cancel kar diya.", "info");
    } else {
      hideModal();
      setStatus(error.message, "error");
    }
  } finally {
    downloadBtn.disabled = false;
    controller = null;
  }
});