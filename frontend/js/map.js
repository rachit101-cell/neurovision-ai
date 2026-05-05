// Leaflet + Overpass map integration for hospitals and specialists

const LOCATION_STORAGE_KEY = "nv_user_location";
const LOCATION_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour - reuse location across tabs/pages
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://lz4.overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

function getStoredLocation() {
  try {
    const raw = sessionStorage.getItem(LOCATION_STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || typeof data.lat !== "number" || typeof data.lon !== "number" || !data.ts) return null;
    if (Date.now() - data.ts > LOCATION_MAX_AGE_MS) return null;
    return { lat: data.lat, lon: data.lon };
  } catch (e) {
    return null;
  }
}

function setStoredLocation(lat, lon) {
  try {
    sessionStorage.setItem(
      LOCATION_STORAGE_KEY,
      JSON.stringify({ lat, lon, ts: Date.now() })
    );
  } catch (e) {}
}

const HOSPITAL_TAGS = [
  '["amenity"="hospital"]',
  '["amenity"="clinic"]',
  '["amenity"="doctors"]',
  '["healthcare"="hospital"]',
  '["healthcare"="clinic"]',
  '["healthcare"="doctor"]',
  '["office"="physician"]',
];

const FACILITY_KEY_FILTERS = [
  '["amenity"]',
  '["healthcare"]',
  '["office"]',
];

const FACILITY_NAME_PATTERNS = [
  "hospital",
  "clinic",
  "medical",
  "health",
  "nursing\\s*home",
  "care\\s*center",
  "diagnostic",
];

const SPECIALIST_KEYWORDS = {
  Neurologist: ["neurolog", "neurosurg", "brain", "neuro"],
  Pulmonologist: ["pulmon", "respirat", "chest", "lung", "pulmonary"],
  Oncologist: ["oncolog", "cancer", "tumor", "tumour", "malignan"],
  "General Physician": ["general", "family", "internal", "physician"],
};

const SPECIALIST_QUERY_PATTERNS = {
  Neurologist: ["neurolog", "neuro", "brain", "neurosurg"],
  Pulmonologist: ["pulmon", "pulmonary", "respirat", "chest", "lung"],
  Oncologist: ["oncolog", "cancer", "tumou?r", "malignan"],
  "General Physician": ["general", "family", "internal", "physician"],
};

function normalizeSpecialistValue(value) {
  return String(value || "").trim().toLowerCase();
}

function getElementCoordinates(el) {
  if (typeof el.lat === "number" && typeof el.lon === "number") {
    return { lat: el.lat, lon: el.lon };
  }

  if (el.center && typeof el.center.lat === "number" && typeof el.center.lon === "number") {
    return { lat: el.center.lat, lon: el.center.lon };
  }

  return null;
}

function getSpecialtySource(tags, name, type) {
  return [
    tags["healthcare:speciality"],
    tags["healthcare:specialty"],
    tags.speciality,
    tags.specialty,
    tags.healthcare,
    type,
    name,
  ]
    .filter(Boolean)
    .join(" | ")
    .toLowerCase();
}

function formatFacilityType(type) {
  const value = String(type || "Hospital").trim();
  if (!value) return "Hospital";
  return value
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatFacilityAddress(tags, coords) {
  if (tags["addr:full"]) {
    return String(tags["addr:full"]).trim();
  }

  const addressParts = [
    [tags["addr:housenumber"], tags["addr:street"]].filter(Boolean).join(" ").trim(),
    tags["addr:suburb"],
    tags["addr:city"] || tags["addr:town"] || tags["addr:village"],
    tags["addr:state"],
    tags["addr:postcode"],
  ].filter(Boolean);

  if (addressParts.length) {
    return addressParts.join(", ");
  }

  return `${coords.lat.toFixed(4)}, ${coords.lon.toFixed(4)}`;
}

function inferSpecialistFromFacility({ specialtySource }) {
  const source = normalizeSpecialistValue(specialtySource);
  const matched = Object.entries(SPECIALIST_KEYWORDS).find(([, keywords]) =>
    keywords.some((keyword) => source.includes(keyword))
  );

  if (matched) {
    return matched[0];
  }

  return "General Physician";
}

function haversineDistanceKm(lat1, lon1, lat2, lon2) {
  const toRad = (v) => (v * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function buildGenericQueryLines(lat, lon, radiusMeters) {
  return HOSPITAL_TAGS.flatMap((tag) => [
    `  node${tag}(around:${radiusMeters},${lat},${lon});`,
    `  way${tag}(around:${radiusMeters},${lat},${lon});`,
    `  relation${tag}(around:${radiusMeters},${lat},${lon});`,
  ]);
}

function escapeOverpassRegex(pattern) {
  return String(pattern || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function buildFacilityNameQueryLines(lat, lon, radiusMeters, patterns) {
  const effectivePatterns = patterns && patterns.length ? patterns : FACILITY_NAME_PATTERNS;
  const regex = escapeOverpassRegex(effectivePatterns.join("|"));
  const searchableFields = ["name", "official_name", "brand", "operator"];

  return FACILITY_KEY_FILTERS.flatMap((facilityKey) =>
    searchableFields.flatMap((field) => [
      `  node${facilityKey}["${field}"~"${regex}", i](around:${radiusMeters},${lat},${lon});`,
      `  way${facilityKey}["${field}"~"${regex}", i](around:${radiusMeters},${lat},${lon});`,
      `  relation${facilityKey}["${field}"~"${regex}", i](around:${radiusMeters},${lat},${lon});`,
    ])
  );
}

function buildSpecialistQueryLines(lat, lon, radiusMeters, specialist) {
  const patterns = SPECIALIST_QUERY_PATTERNS[specialist];
  if (!patterns || !patterns.length) {
    return buildGenericQueryLines(lat, lon, radiusMeters);
  }

  const regex = escapeOverpassRegex(patterns.join("|"));
  const searchableFields = [
    "healthcare:speciality",
    "healthcare:specialty",
    "speciality",
    "specialty",
    "name",
  ];

  return HOSPITAL_TAGS.flatMap((tag) =>
    searchableFields.flatMap((field) => [
      `  node${tag}["${field}"~"${regex}", i](around:${radiusMeters},${lat},${lon});`,
      `  way${tag}["${field}"~"${regex}", i](around:${radiusMeters},${lat},${lon});`,
      `  relation${tag}["${field}"~"${regex}", i](around:${radiusMeters},${lat},${lon});`,
    ])
  );
}

async function fetchOverpassJson(query) {
  const body = "data=" + encodeURIComponent(query);
  let lastError = null;

  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        body,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        },
      });

      if (!res.ok) {
        lastError = new Error(`Overpass error ${res.status} from ${endpoint}`);
        continue;
      }

      return await res.json();
    } catch (e) {
      lastError = e;
    }
  }

  throw lastError || new Error("Unable to reach hospital map service.");
}

async function queryHospitals(
  lat,
  lon,
  radiusMeters = 6000,
  preferredSpecialist = null,
  namePatterns = null
) {
  let queryLines = [];

  if (namePatterns && namePatterns.length) {
    queryLines = buildFacilityNameQueryLines(lat, lon, radiusMeters, namePatterns);
  } else if (preferredSpecialist && preferredSpecialist !== "all") {
    queryLines = buildSpecialistQueryLines(lat, lon, radiusMeters, preferredSpecialist);
  } else {
    queryLines = buildGenericQueryLines(lat, lon, radiusMeters);
  }

  const query = `
[out:json];
(
${queryLines.join("\n")}
);
out center 120;
`;
  const data = await fetchOverpassJson(query);
  const seen = new Set();

  return (data.elements || []).map((el) => {
    const coords = getElementCoordinates(el);
    if (!coords) return null;

    const tags = el.tags || {};
    const name = (tags.name || tags["addr:housename"]) || "Unnamed facility";
    const type =
      tags.amenity ||
      tags.healthcare ||
      tags["healthcare:speciality"] ||
      tags["healthcare:specialty"] ||
      "Hospital";
    const specialtySource = getSpecialtySource(tags, name, type);
    const phone =
      tags["contact:phone"] || tags.phone || tags["addr:phone"] || tags["contact:mobile"] || "";
    const dedupeKey = `${name.toLowerCase()}|${coords.lat.toFixed(4)}|${coords.lon.toFixed(4)}`;

    if (seen.has(dedupeKey)) return null;
    seen.add(dedupeKey);

    return {
      id: `${el.type}-${el.id}`,
      name,
      lat: coords.lat,
      lon: coords.lon,
      type: formatFacilityType(type),
      address: formatFacilityAddress(tags, coords),
      specialtySource,
      matchedSpecialist: preferredSpecialist || null,
      phone: (phone && String(phone).trim()) || null,
    };
  }).filter(Boolean);
}

async function queryHospitalsWithFallback(lat, lon, preferredSpecialist = null) {
  const searchRadii = [6000, 12000, 25000];

  if (preferredSpecialist && preferredSpecialist !== "all") {
    const specialistNamePatterns = [
      ...(SPECIALIST_QUERY_PATTERNS[preferredSpecialist] || []),
      ...FACILITY_NAME_PATTERNS,
    ];

    for (const radius of searchRadii) {
      const specialistResults = await queryHospitals(lat, lon, radius, preferredSpecialist);
      if (specialistResults.length) {
        return specialistResults;
      }
    }

    for (const radius of searchRadii) {
      const specialistNameResults = await queryHospitals(
        lat,
        lon,
        radius,
        preferredSpecialist,
        specialistNamePatterns
      );
      if (specialistNameResults.length) {
        return specialistNameResults;
      }
    }
  }

  for (const radius of searchRadii) {
    const genericResults = await queryHospitals(lat, lon, radius, null);
    if (genericResults.length) {
      return genericResults;
    }
  }

  for (const radius of searchRadii) {
    const nameResults = await queryHospitals(lat, lon, radius, null, FACILITY_NAME_PATTERNS);
    if (nameResults.length) {
      return nameResults;
    }
  }

  return [];
}

function deriveSpecialistType(hospital) {
  const specialist =
    hospital.matchedSpecialist ||
    inferSpecialistFromFacility({
      specialtySource: hospital.specialtySource,
    });

  if (hospital.type && hospital.type.toLowerCase().includes("clinic")) {
    return specialist + " (Clinic)";
  }

  return specialist;
}

function decorateHospitalsWithDistanceAndRating(hospitals, userLat, userLon) {
  return hospitals.map((h) => {
    const distanceKm = haversineDistanceKm(userLat, userLon, h.lat, h.lon);
    const specialist = deriveSpecialistType(h);
    const hasPhone = Boolean(h.phone);
    const typeLabel = String(h.type || "").toLowerCase();
    const isHospital = typeLabel.includes("hospital");
    const isClinic = typeLabel.includes("clinic");
    const baseScore = 3.5 + (isHospital ? 0.6 : 0.25) + (isClinic ? 0.1 : 0) + (hasPhone ? 0.35 : 0);
    const distanceAdjustment = Math.max(0, 0.35 - Math.min(distanceKm, 10) * 0.03);

    return {
      ...h,
      distanceKm,
      rating: Math.min(5, parseFloat((baseScore + distanceAdjustment).toFixed(1))),
      specialist,
      specialistKey: normalizeSpecialistValue(specialist.replace(/\s*\(clinic\)\s*/i, "")),
    };
  });
}

function escapeHtml(str) {
  if (!str) return "";
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function escapeAttr(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function updateMapMarkers(map, markersLayer, hospitals) {
  if (!map || !markersLayer || typeof L === "undefined") return;

  markersLayer.clearLayers();
  hospitals.forEach((h) => {
    const marker = L.marker([h.lat, h.lon]).addTo(markersLayer);
    marker.bindPopup(
      `<b>${escapeHtml(h.name)}</b><br/>` +
      `${escapeHtml(h.type)}<br/>` +
      `${escapeHtml(h.specialist)}<br/>` +
      `${escapeHtml(h.address)}<br/>` +
      `Phone: ${escapeHtml(h.phone || "Not listed")}<br/>` +
      `${h.distanceKm.toFixed(1)} km away`
    );
  });
}

function createLeafletMap(elementId, userLat, userLon) {
  const el = document.getElementById(elementId);
  if (!el || typeof L === "undefined") return null;

  const map = L.map(elementId, { zoomControl: true }).setView([userLat, userLon], 13);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(map);

  L.circleMarker([userLat, userLon], {
    radius: 8,
    color: "#22c55e",
    fillColor: "#22c55e",
    fillOpacity: 0.9,
  })
    .bindPopup("Your location")
    .addTo(map);

  return map;
}

function renderHospitalStatus(listElementId, title, detail) {
  const list = document.getElementById(listElementId);
  if (!list) return;

  list.innerHTML = "";
  const li = document.createElement("li");
  li.className = "hospital-card";
  li.innerHTML = `
    <div class="hospital-name">${escapeHtml(title)}</div>
    <div class="hospital-meta">
      <span>${escapeHtml(detail)}</span>
    </div>
  `;
  list.appendChild(li);
}

function renderHospitalCards(listElementId, hospitals) {
  const list = document.getElementById(listElementId);
  if (!list) return;

  list.innerHTML = "";

  if (!hospitals.length) {
    renderHospitalStatus(
      listElementId,
      "No hospitals found",
      "Try refreshing the map or expanding the search area."
    );
    return;
  }

  hospitals.forEach((h) => {
    const li = document.createElement("li");
    li.className = "hospital-card";
    const phone = h.phone;
    const callLabel = phone ? `Call ${escapeHtml(phone)}` : "Call Hospital";
    const telHref = phone ? "tel:" + phone.replace(/[^\d+\s\-()]/g, "").trim() : "";
    const callMarkup = phone
      ? `<a href="${escapeAttr(telHref)}" class="btn btn-ghost btn-xs" data-type="call">${callLabel}</a>`
      : `<button class="btn btn-ghost btn-xs" data-type="call" title="Phone not in map data">${callLabel}</button>`;

    li.innerHTML = `
      <div class="hospital-name">${escapeHtml(h.name)}</div>
      <div class="hospital-meta">
        <span>${escapeHtml(h.type)}</span>
        <span>${escapeHtml(h.specialist)}</span>
        <span>${h.distanceKm.toFixed(1)} km</span>
        <span class="rating">Rating ${h.rating.toFixed(1)}</span>
      </div>
      <div class="hospital-location">${escapeHtml(h.address)}</div>
      <div class="hospital-contact">
        <span>Phone:</span>
        <span>${phone ? escapeHtml(phone) : "Not listed"}</span>
      </div>
      <div class="hospital-actions">
        <button class="btn btn-outline btn-xs" data-lat="${h.lat}" data-lon="${h.lon}" data-type="directions">Directions</button>
        ${callMarkup}
      </div>
    `;
    list.appendChild(li);
  });

  if (!list.hasAttribute("data-delegation-bound")) {
    list.setAttribute("data-delegation-bound", "true");
    list.addEventListener("click", (e) => {
      const target = e.target.closest("[data-type]");
      if (!target || !(target instanceof HTMLElement)) return;
      const type = target.getAttribute("data-type");
      if (!type) return;

      if (type === "directions") {
        const lat = target.getAttribute("data-lat");
        const lon = target.getAttribute("data-lon");
        if (lat && lon) {
          window.open(`https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}`, "_blank");
        }
      } else if (type === "call" && target.tagName !== "A") {
        alert("Phone number not available for this facility. Try searching the hospital name online for contact details.");
      }
    });
  }
}

function runMapWithLocation(userLat, userLon, mapElementId, listElementId, sortSelectId, specialistFilterId) {
  const map = createLeafletMap(mapElementId, userLat, userLon);
  if (!map) return;

  let hospitals = [];
  const markersLayer = typeof L === "undefined" ? null : L.layerGroup().addTo(map);
  const sortSelect = sortSelectId ? document.getElementById(sortSelectId) : null;
  const specFilter = specialistFilterId ? document.getElementById(specialistFilterId) : null;
  let latestRequestId = 0;

  function applyFiltersAndSort() {
    let items = hospitals.slice();
    if (specFilter && specFilter.value && specFilter.value !== "all") {
      const selectedSpecialist = normalizeSpecialistValue(specFilter.value);
      items = items.filter((h) => h.specialistKey === selectedSpecialist);
    }
    if (sortSelect) {
      if (sortSelect.value === "rating") {
        items.sort((a, b) => b.rating - a.rating);
      } else {
        items.sort((a, b) => a.distanceKm - b.distanceKm);
      }
    }
    renderHospitalCards(listElementId, items);
    updateMapMarkers(map, markersLayer, items);
  }

  async function loadHospitalsForSelection() {
    const requestId = ++latestRequestId;
    const selectedSpecialist =
      specFilter && specFilter.value && specFilter.value !== "all" ? specFilter.value : null;

    try {
      const raw = await queryHospitalsWithFallback(userLat, userLon, selectedSpecialist);
      if (requestId !== latestRequestId) return;
      hospitals = decorateHospitalsWithDistanceAndRating(raw, userLat, userLon);
      applyFiltersAndSort();
    } catch (e) {
      if (requestId !== latestRequestId) return;
      hospitals = [];
      renderHospitalStatus(
        listElementId,
        "Could not load hospitals",
        "The hospital map service did not respond. Use Refresh Map and try again."
      );
      updateMapMarkers(map, markersLayer, []);
      console.error("Error loading hospitals", e);
    }
  }

  if (sortSelect) sortSelect.addEventListener("change", applyFiltersAndSort);
  if (specFilter) specFilter.addEventListener("change", loadHospitalsForSelection);

  loadHospitalsForSelection();
}

async function initMapBlock({
  mapElementId,
  listElementId,
  sortSelectId,
  specialistFilterId,
}) {
  const stored = getStoredLocation();
  if (stored) {
    runMapWithLocation(stored.lat, stored.lon, mapElementId, listElementId, sortSelectId, specialistFilterId);
    return;
  }

  if (typeof navigator === "undefined" || !navigator.geolocation) {
    return;
  }

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const userLat = pos.coords.latitude;
      const userLon = pos.coords.longitude;
      setStoredLocation(userLat, userLon);
      runMapWithLocation(userLat, userLon, mapElementId, listElementId, sortSelectId, specialistFilterId);
    },
    (err) => console.warn("Geolocation error", err),
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

document.addEventListener("DOMContentLoaded", () => {
  if (document.getElementById("map-dashboard")) {
    initMapBlock({
      mapElementId: "map-dashboard",
      listElementId: "hospital-list-dashboard",
      sortSelectId: "sort-select",
    });

    const refreshBtn = document.getElementById("refresh-map-btn");
    if (refreshBtn) {
      refreshBtn.addEventListener("click", () => {
        try {
          sessionStorage.removeItem(LOCATION_STORAGE_KEY);
        } catch (e) {}
        window.location.reload();
      });
    }
  }

  if (document.getElementById("map-preview")) {
    initMapBlock({
      mapElementId: "map-preview",
      listElementId: "map-preview-list",
      sortSelectId: null,
    });
  }
});
