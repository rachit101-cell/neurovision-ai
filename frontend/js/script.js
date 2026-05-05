// Core frontend logic: prediction workflow, scan viewer, and report generation

// Base URL for the Flask backend. If you change the backend host/port,
// update this value, but keep the /predict/* routes unchanged.
const API_BASE = "https://neurovision-ai-mj40.onrender.com";

// Transparent 1x1 so clearing img src doesn't show broken icon
const EMPTY_IMG_SRC = "data:image/gif;base64,R0lGOODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

function $(selector) {
  return document.querySelector(selector);
}

function setTextSafe(el, value) {
  if (el) el.textContent = value;
}

function setWidthSafe(el, value) {
  if (el) el.style.width = value;
}

function hideElement(el) {
  if (el) el.style.display = "none";
}

function showElement(el, display = "block") {
  if (el) el.style.display = display;
}

function getEndpointForModel(modelKey) {
  if (modelKey === "pneumonia") return "/predict/pneumonia";
  if (modelKey === "lung") return "/predict/lung";
  return "/predict/pneumonia";
}

// Doctor recommendation mapping
function getSpecialistForPrediction(prediction) {
  if (!prediction) return "General Physician";
  const p = String(prediction).trim().toUpperCase();
  if (p === "NORMAL") return "General Physician";
  if (p.includes("PNEUMONIA")) return "Pulmonologist";
  if (p.includes("BENIGN") || p.includes("MALIGNANT") || p.includes("CANCER")) return "Oncologist";
  return "General Physician";
}

// Persist last prediction for cross‑page report generation
function saveReportState(prediction, confidence) {
  try {
    const specialist = getSpecialistForPrediction(prediction);
    const payload = {
      prediction,
      confidence,
      specialist,
      timestamp: new Date().toISOString(),
    };
    sessionStorage.setItem("nv_last_report", JSON.stringify(payload));
  } catch (e) {
    // non‑critical
  }
}

function loadReportState() {
  try {
    const raw = sessionStorage.getItem("nv_last_report");
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

// jsPDF report
function generateReportPdf() {
  const state = loadReportState();
  if (!state) {
    alert("No recent AI prediction found. Run an analysis first.");
    return;
  }

  if (!window.jspdf && !window.jsPDF) {
    alert("Report module not loaded.");
    return;
  }

  const { jsPDF } = window.jspdf || window;
  const doc = new jsPDF();

  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.text("NeuroVision AI – Clinical Report", 14, 20);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(11);
  doc.text(`Generated: ${new Date(state.timestamp).toLocaleString()}`, 14, 30);

  doc.setFontSize(13);
  doc.setFont("helvetica", "bold");
  doc.text("Prediction Summary", 14, 45);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(12);
  doc.text(`Disease prediction: ${state.prediction}`, 14, 55);
  doc.text(`Confidence: ${(state.confidence * 100).toFixed(1)} %`, 14, 63);
  doc.text(`Recommended specialist: ${state.specialist}`, 14, 71);

  doc.setFontSize(11);
  doc.text(
    "This report is intended for clinical decision support only and is not a substitute for a licensed physician.",
    14,
    90,
    { maxWidth: 180 }
  );

  doc.save("neurovision-ai-report.pdf");
}

// Scanning animation helpers
function setScanningState(isScanning, container) {
  const viewer = container;
  if (!viewer) return;
  if (isScanning) {
    viewer.classList.add("scan-loading");
  } else {
    viewer.classList.remove("scan-loading");
  }
}

// Shared prediction request
async function runPrediction({ file, modelKey, previewImg, heatmapImg, statusEl, viewerContainer }) {
  if (!file) {
    if (statusEl) statusEl.textContent = "Please select an image before analyzing.";
    return;
  }

  const endpoint = API_BASE + getEndpointForModel(modelKey);
  const formData = new FormData();
  formData.append("image", file);

  // Immediate visual preview
  if (previewImg) {
    const reader = new FileReader();
    reader.onload = (e) => {
      previewImg.src = e.target.result;
      previewImg.style.opacity = "1";
    };
    reader.readAsDataURL(file);
  }

  if (statusEl) {
    statusEl.textContent = "Analyzing scan with AI model…";
  }
  setScanningState(true, viewerContainer);

  const diseaseLabelEl = $("#disease-label");
  const confidenceLabelEl = $("#confidence-label");
  const specialistLabelEl = $("#specialist-label");
  const triageBadgeEl = $("#triage-badge");
  const barEl = $("#confidence-bar");

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      body: formData,
    });

    if (!response.ok) {
      throw new Error("API responded with status " + response.status);
    }

    const data = await response.json();

    const prediction = data.prediction || "Unknown";
    const confidence = typeof data.confidence === "number" ? data.confidence : 0;

    setTextSafe(diseaseLabelEl, prediction);
    setTextSafe(confidenceLabelEl, confidence ? (confidence * 100).toFixed(1) + " %" : "–");
    if (barEl) {
      setWidthSafe(barEl, (confidence * 100).toFixed(1) + "%");
    }

    const specialist = getSpecialistForPrediction(prediction);
    setTextSafe(specialistLabelEl, specialist);
    if (triageBadgeEl) {
      triageBadgeEl.textContent = confidence > 0.8 ? "High confidence" : "Review with caution";
    }

    if (heatmapImg) {
      heatmapImg.src = EMPTY_IMG_SRC;
      heatmapImg.style.opacity = "0";
      heatmapImg.style.visibility = "hidden";
    }

    saveReportState(prediction, confidence || 0);

    if (statusEl) {
      statusEl.textContent = "Analysis complete.";
    }
  } catch (err) {
    console.error(err);
    if (statusEl) {
      statusEl.textContent = "There was a problem contacting the AI service. Please try again.";
    }
  } finally {
    setScanningState(false, viewerContainer);
  }
}

// Dashboard scan viewer
function initDashboardScanViewer() {
  const fileInput = $("#file-input-dashboard");
  const modelSelect = $("#model-select-dashboard");
  const analyzeBtn = $("#analyze-btn-dashboard");
  const previewImg = $("#scan-preview");
  const heatmapImg = $("#scan-heatmap");
  const placeholder = $("#scan-placeholder");
  const statusEl = $("#scan-status");
  const viewerContainer = document.querySelector(".scan-viewer");

  if (!fileInput || !modelSelect || !analyzeBtn || !previewImg || !heatmapImg || !viewerContainer) return;

  let currentFile = null;

  fileInput.addEventListener("change", (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    currentFile = file;
    hideElement(placeholder);

    const reader = new FileReader();
    reader.onload = (ev) => {
      previewImg.src = ev.target.result;
      previewImg.style.opacity = "1";
      previewImg.style.visibility = "visible";
      heatmapImg.src = EMPTY_IMG_SRC;
      heatmapImg.style.opacity = "0";
      heatmapImg.style.visibility = "hidden";
    };
    reader.readAsDataURL(file);
  });

  analyzeBtn.addEventListener("click", () => {
    const modelKey = modelSelect.value || "pneumonia";
    runPrediction({
      file: currentFile,
      modelKey,
      previewImg,
      heatmapImg,
      statusEl,
      viewerContainer,
    });
  });
}

// Upload page scan viewer
function initUploadPage() {
  const fileInput = $("#file-input-upload");
  const modelSelect = $("#model-select-upload");
  const analyzeBtn = $("#analyze-btn-upload");
  const previewImg = $("#upload-preview");
  const heatmapImg = $("#upload-heatmap");
  const placeholder = $("#upload-placeholder");
  const statusEl = $("#upload-status");
  const viewerContainer = document.querySelector(".image-container.scan-viewer");

  if (!fileInput || !modelSelect || !analyzeBtn || !previewImg || !heatmapImg || !viewerContainer) return;

  let currentFile = null;

  fileInput.addEventListener("change", (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    currentFile = file;
    hideElement(placeholder);

    const reader = new FileReader();
    reader.onload = (ev) => {
      previewImg.src = ev.target.result;
      previewImg.style.opacity = "1";
      previewImg.style.visibility = "visible";
      heatmapImg.src = EMPTY_IMG_SRC;
      heatmapImg.style.opacity = "0";
      heatmapImg.style.visibility = "hidden";
    };
    reader.readAsDataURL(file);
  });

  analyzeBtn.addEventListener("click", () => {
    const modelKey = modelSelect.value || "pneumonia";
    runPrediction({
      file: currentFile,
      modelKey,
      previewImg,
      heatmapImg,
      statusEl,
      viewerContainer,
    });
  });
}

function initReportButtons() {
  const btnDashboard = $("#download-report-btn");
  const btnDoctors = $("#download-report-btn-doctors");

  if (btnDashboard) {
    btnDashboard.addEventListener("click", generateReportPdf);
  }
  if (btnDoctors) {
    btnDoctors.addEventListener("click", generateReportPdf);
  }
}

function initFragmentNavigation() {
  // Highlight sidebar navigation and scroll to hash targets when present.
  const hash = window.location.hash;
  if (hash) {
    const target = document.querySelector(hash);
    if (target) {
      // Ensure the element is in view for users navigating via #predictions
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  const navItems = document.querySelectorAll(".sidebar .nav-item");
  if (navItems.length === 0) return;

  const currentPage = window.location.pathname.split("/").pop();

  navItems.forEach((item) => {
    const href = item.getAttribute("href");
    const normalized = href ? href.split("?")[0].split("#")[0] : "";

    // Mark active for current page or for #predictions when on dashboard
    const isActive =
      (normalized && normalized === currentPage) ||
      (hash === "#predictions" && href.includes("#predictions"));

    item.classList.toggle("active", isActive);
  });
}

document.addEventListener("DOMContentLoaded", () => {
  initDashboardScanViewer();
  initUploadPage();
  initReportButtons();
  initFragmentNavigation();
});
