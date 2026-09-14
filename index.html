<!DOCTYPE html>
<html lang="en" class="h-full">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>WetFloorWatch | Hamilton Intelligence Grid</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
    <link rel="stylesheet" href="https://unpkg.com/leaflet.markercluster@1.4.1/dist/MarkerCluster.css" />
    <link rel="stylesheet" href="https://unpkg.com/leaflet.markercluster@1.4.1/dist/MarkerCluster.Default.css" />
    
    <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
    <script src="https://unpkg.com/leaflet.markercluster@1.4.1/dist/leaflet.markercluster.js"></script>
    <script src="https://unpkg.com/leaflet.heat/dist/leaflet-heat.js"></script>
    
    <style>
        body { -webkit-font-smoothing: antialiased; font-family: ui-sans-serif, system-ui, sans-serif; }
        .leaflet-container { background: #020617 !important; }
        .leaflet-tile { filter: brightness(0.5) invert(1) contrast(2.8) hue-rotate(200deg) saturate(0.25); }
        .custom-div-icon { background: transparent; border: none; }
        .leaflet-popup-content-wrapper, .leaflet-popup-tip {
            background: #0f172a !important; color: #f8fafc !important; border: 1px solid #1e293b;
        }
        .marker-cluster { background-color: rgba(245, 158, 11, 0.7); border-radius: 50%; font-weight: bold; color: white; display: flex; align-items: center; justify-content: center; border: 2px solid #f59e0b; box-shadow: 0 0 15px rgba(245, 158, 11, 0.4); }
        .scrollbar-hide::-webkit-scrollbar { display: none; }
    </style>
</head>
<body class="h-full bg-slate-950 text-slate-100 flex flex-col overflow-hidden">

    <!-- HEADER COMMAND CENTER -->
    <header class="bg-slate-950/95 backdrop-blur-md border-b border-slate-800 h-16 flex items-center justify-between px-4 z-20 shadow-lg">
        <div class="flex items-center space-x-3">
            <div class="bg-amber-500/10 p-2 rounded-xl border border-amber-500/30">
                <svg class="w-6 h-6 text-amber-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L1 21h22L12 2zm0 3.5L19.5 19h-15L12 5.5z"/><path d="M11 10h2v4h-2zm0 6h2v2h-2z"/></svg>
            </div>
            <div>
                <h1 class="font-bold text-lg tracking-tight text-white flex items-center gap-2">WetFloorWatch <span class="text-pink-400 font-mono text-[9px] uppercase bg-pink-500/10 px-2 py-0.5 rounded border border-pink-500/30">Active Grid</span></h1>
                <p class="text-[10px] text-slate-400 font-medium hidden sm:block tracking-wide uppercase">Hamilton Threat & Hazard Intelligence</p>
            </div>
        </div>
        <div class="flex items-center space-x-2.5">
            <button id="auth-btn" class="bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold text-xs px-3.5 py-2.5 rounded-xl border border-slate-700 transition cursor-pointer">Sign In</button>
            <button id="open-report-modal" class="hidden bg-gradient-to-r from-amber-600 to-amber-500 text-slate-950 font-extrabold text-xs px-3.5 py-2.5 rounded-xl transition cursor-pointer flex items-center gap-1.5">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/></svg>
                Report Wet Floor
            </button>
        </div>
    </header>

    <div class="flex-1 flex relative overflow-hidden bg-slate-950">
        <!-- SIDEBAR -->
        <aside id="sidebar" class="absolute md:relative inset-y-0 left-0 z-30 w-[420px] bg-slate-900 border-r border-slate-800 flex flex-col shadow-2xl">
            
            <div class="p-3 border-b border-slate-800 bg-slate-950/90 grid grid-cols-2 gap-2.5 flex-shrink-0">
                <a href="https://ko-fi.com/eclipz" target="_blank" rel="noopener noreferrer" class="bg-[#13C3FF]/15 hover:bg-[#13C3FF]/25 border border-[#13C3FF]/40 text-[#13C3FF] font-bold text-xs py-2 rounded-xl text-center transition flex items-center justify-center gap-1.5">Ko-fi Support</a>
                <a href="https://www.paypal.com/paypalme/3cl1pz" target="_blank" rel="noopener noreferrer" class="bg-[#00457C]/30 hover:bg-[#00457C]/50 border border-[#0079C1]/50 text-[#0079C1] font-bold text-xs py-2 rounded-xl text-center transition flex items-center justify-center gap-1.5">PayPal Support</a>
            </div>

            <!-- COMMUNITY WATCH PROFILE CARD (Wired as a filter) -->
            <div class="p-3 border-b border-slate-800 bg-slate-950/60 flex-shrink-0 cursor-pointer hover:bg-slate-900 transition" onclick="switchMainTab('intervention')">
                <div class="group flex items-center justify-between p-2.5 bg-slate-900 border border-fuchsia-500/30 rounded-xl transition">
                    <div class="flex items-center space-x-3">
                        <div class="w-8 h-8 rounded-full bg-gradient-to-tr from-yellow-500 via-pink-500 to-fuchsia-500 p-[2px]">
                            <div class="w-full h-full bg-slate-950 rounded-full flex items-center justify-center text-[10px] text-white font-bold">IG</div>
                        </div>
                        <div>
                            <span class="text-[9px] font-mono text-fuchsia-400 uppercase tracking-wider block font-bold">Community Watch Feed</span>
                            <span class="text-xs font-bold text-slate-100 group-hover:text-fuchsia-300 transition">@interventionintersection2026</span>
                        </div>
                    </div>
                    <span class="text-[10px] font-bold text-fuchsia-400 bg-fuchsia-500/10 px-2 py-1 rounded border border-fuchsia-500/30">View Posts ↗</span>
                </div>
            </div>

            <!-- FILTERS & CONTROLS -->
            <div class="p-3 space-y-3 bg-slate-950/20 border-b border-slate-800 flex-shrink-0">
                <div class="bg-slate-950 border border-slate-700/50 p-2.5 rounded-xl flex items-center justify-between shadow-inner">
                    <span class="text-xs font-bold text-slate-200">City-Wide Danger Heatmap</span>
                    <label class="relative inline-flex items-center cursor-pointer">
                        <input type="checkbox" id="heatmap-toggle" checked class="sr-only peer">
                        <div class="w-9 h-5 bg-slate-800 rounded-full peer peer-checked:bg-rose-600 after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-full"></div>
                    </label>
                </div>
            </div>

            <!-- MAIN DATA TABS -->
            <div class="px-3 pt-3 flex-shrink-0 bg-slate-950/40 border-b border-slate-800 pb-2">
                <div class="flex gap-1.5 overflow-x-auto scrollbar-hide text-[10px]">
                    <button onclick="switchMainTab('all')" id="main-tab-all" class="main-tab px-2.5 py-1.5 rounded-lg bg-amber-500/20 text-amber-300 border border-amber-500/40 font-bold transition cursor-pointer whitespace-nowrap">All Data</button>
                    <button onclick="switchMainTab('police')" id="main-tab-police" class="main-tab px-2.5 py-1.5 rounded-lg bg-slate-800 text-slate-300 border border-slate-700 font-bold transition cursor-pointer whitespace-nowrap">Police/EMS</button>
                    <button onclick="switchMainTab('news')" id="main-tab-news" class="main-tab px-2.5 py-1.5 rounded-lg bg-slate-800 text-slate-300 border border-slate-700 font-bold transition cursor-pointer whitespace-nowrap">News</button>
                    <button onclick="switchMainTab('word_of_mouth')" id="main-tab-wom" class="main-tab px-2.5 py-1.5 rounded-lg bg-slate-800 text-slate-300 border border-slate-700 font-bold transition cursor-pointer whitespace-nowrap">Word of Mouth</button>
                    <button onclick="switchMainTab('intervention')" id="main-tab-intervention" class="main-tab px-2.5 py-1.5 rounded-lg bg-slate-800 text-slate-300 border border-slate-700 font-bold transition cursor-pointer whitespace-nowrap hidden">Intervention</button>
                </div>
            </div>

            <!-- FEED LIST -->
            <div class="flex-1 overflow-y-auto p-3 space-y-2.5 bg-slate-950/40">
                <div class="flex items-center justify-between mb-2">
                    <span class="text-[10px] font-bold text-slate-400 uppercase tracking-widest" id="active-count">0 accurate records</span>
                </div>
                <div id="feed-list" class="space-y-2"></div>
            </div>
        </aside>

        <!-- MAP CONTAINER -->
        <main class="flex-1 h-full relative">
            <div id="map" class="w-full h-full z-10"></div>
        </main>
    </div>

    <!-- REPORT WET FLOOR MODAL -->
    <div id="report-modal" class="fixed inset-0 z-[60] hidden items-center justify-center bg-slate-950/90 backdrop-blur-sm p-4">
        <div class="bg-slate-900 border border-slate-700 rounded-2xl max-w-md w-full p-6 shadow-2xl space-y-4">
            <div class="flex justify-between border-b border-slate-800 pb-3">
                <h3 id="modal-title" class="font-bold text-lg text-white">Sign In / Secure Report</h3>
                <button id="close-modal" class="text-slate-400 hover:text-white cursor-pointer">✕</button>
            </div>
            
            <div id="auth-section" class="space-y-3">
                <p class="text-xs text-amber-400">Secure sign-in required to prevent spam.</p>
                <input type="email" id="auth-email" placeholder="Email Address" class="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-200 font-mono">
                <input type="password" id="auth-pass" placeholder="Password" class="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-200 font-mono">
                <div class="flex gap-2">
                    <button id="btn-login" class="flex-1 bg-slate-800 text-white font-bold py-2 rounded-xl text-xs cursor-pointer">Login</button>
                    <button id="btn-signup" class="flex-1 bg-slate-700 text-white font-bold py-2 rounded-xl text-xs cursor-pointer">Register</button>
                </div>
            </div>

            <form id="hazard-form" class="hidden space-y-3 relative">
                <div id="gps-status" class="bg-slate-950 border border-slate-700 p-2.5 rounded-xl text-xs text-slate-300 font-mono flex justify-between items-center">
                    <span>📡 Fetching GPS coordinates...</span>
                    <span class="w-2 h-2 rounded-full bg-amber-500 animate-pulse"></span>
                </div>

                <select id="hazard-type" class="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-200">
                    <option value="hazard">Drug / Hazard</option>
                    <option value="street">Social Intel / Harassment</option>
                    <option value="emergency">Emergency</option>
                </select>
                
                <div class="relative">
                    <input type="text" id="hazard-loc" autocomplete="off" placeholder="Or type intersection to override GPS..." class="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-200 font-mono">
                    <div id="address-suggestions" class="absolute left-0 right-0 top-full mt-1 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl z-50 max-h-40 overflow-y-auto hidden"></div>
                </div>
                
                <input type="hidden" id="selected-lat" value="">
                <input type="hidden" id="selected-lng" value="">
                
                <textarea id="hazard-desc" placeholder="Specific details. No names, no exact house numbers..." rows="3" class="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-200" required></textarea>
                <button type="submit" class="w-full bg-amber-500 hover:bg-amber-400 transition text-slate-950 font-extrabold py-3 rounded-xl text-xs cursor-pointer uppercase tracking-wider">Submit Report</button>
            </form>
        </div>
    </div>

    <script type="module">
        import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
        import { getFirestore, collection, addDoc, onSnapshot, query, orderBy, limit, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
        import { getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

        const app = initializeApp({
            apiKey: "AIzaSyDsUcJX5_sTFZ4gYbetTtQjN95sDD1vuks",
            authDomain: "wetfloorwatch.firebaseapp.com",
            projectId: "wetfloorwatch"
        });
        const db = getFirestore(app);
        const auth = getAuth(app);

        const map = L.map('map', { zoomControl: false }).setView([43.2557, -79.8711], 13);
        L.control.zoom({ position: 'bottomright' }).addTo(map);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(map);
        
        const clusterGroup = L.markerClusterGroup({ 
            maxClusterRadius: 40,
            polygonOptions: { fillColor: '#f59e0b', color: '#f59e0b', weight: 2, opacity: 1, fillOpacity: 0.3 }
        });
        map.addLayer(clusterGroup);
        
        let heatLayer = null;
        let rawReports = [];
        let currentMainTab = 'all';

        // LIVE OPENSTREETMAP API AUTO-PREDICT
        const locInput = document.getElementById('hazard-loc');
        const suggestionsBox = document.getElementById('address-suggestions');
        let searchTimeout;
        
        locInput.oninput = (e) => {
            clearTimeout(searchTimeout);
            const q = e.target.value.trim();
            if (q.length < 4) { suggestionsBox.classList.add('hidden'); return; }
            
            suggestionsBox.innerHTML = '<div class="p-2.5 text-xs text-slate-400 font-mono">Searching OpenStreetMap...</div>';
            suggestionsBox.classList.remove('hidden');

            searchTimeout = setTimeout(async () => {
                try {
                    const res = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}+Hamilton,+ON&format=json&addressdetails=1&limit=5`);
                    const data = await res.json();
                    
                    if(data.length === 0) {
                        suggestionsBox.innerHTML = '<div class="p-2.5 text-xs text-rose-400 font-mono">No matching Hamilton streets found.</div>';
                        return;
                    }

                    suggestionsBox.innerHTML = data.map(m => `
                        <div class="p-2.5 hover:bg-slate-800 text-xs text-slate-200 cursor-pointer border-b border-slate-800 font-mono truncate" 
                             data-lat="${m.lat}" data-lng="${m.lon}" data-name="${m.display_name.split(',')[0]}">
                            📍 ${m.display_name.split(', Hamilton')[0]}
                        </div>
                    `).join('');
                    
                    suggestionsBox.querySelectorAll('div').forEach(el => {
                        el.onclick = () => {
                            locInput.value = el.getAttribute('data-name');
                            document.getElementById('selected-lat').value = el.getAttribute('data-lat');
                            document.getElementById('selected-lng').value = el.getAttribute('data-lng');
                            document.getElementById('gps-status').innerHTML = '<span>📍 Manual Override Active</span><span class="w-2 h-2 rounded-full bg-sky-400"></span>';
                            suggestionsBox.classList.add('hidden');
                        };
                    });
                } catch(err) { console.error("Geocoding error"); }
            }, 600);
        };

        function getIcon(cat) {
            const colors = { emergency: '#dc2626', advisory: '#38bdf8', hazard: '#f59e0b', street: '#d946ef' };
            const color = colors[cat] || '#f59e0b';
            return L.divIcon({
                className: 'custom-div-icon',
                html: `<div class="w-4 h-4 rounded-full border-2 border-slate-900" style="background-color: ${color}; box-shadow: 0 0 10px ${color};"></div>`
            });
        }

        window.switchMainTab = function(tab) {
            currentMainTab = tab;
            document.querySelectorAll('.main-tab').forEach(btn => {
                btn.className = "main-tab px-2.5 py-1.5 rounded-lg bg-slate-800 text-slate-300 border border-slate-700 font-bold transition cursor-pointer whitespace-nowrap";
                if(btn.id === 'main-tab-intervention') btn.classList.add('hidden'); // keep it hidden from top bar unless active
            });
            
            const activeBtn = document.getElementById(`main-tab-${tab === 'word_of_mouth' ? 'wom' : tab}`);
            if(activeBtn) {
                activeBtn.className = "main-tab px-2.5 py-1.5 rounded-lg bg-amber-500/20 text-amber-300 border border-amber-500/40 font-bold transition cursor-pointer whitespace-nowrap";
                activeBtn.classList.remove('hidden');
            }
            filterAndRender();
        };

        function formatTimestamp(ts) {
            if (!ts) return 'Unknown';
            const date = ts.toDate ? ts.toDate() : new Date(ts);
            return date.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
        }

        function filterAndRender() {
            clusterGroup.clearLayers();
            if (heatLayer) map.removeLayer(heatLayer);
            
            const feedContainer = document.getElementById('feed-list');
            feedContainer.innerHTML = '';
            let heatPoints = [];
            let visibleCount = 0;

            rawReports.forEach(item => {
                const p = (item.platform || '').toLowerCase();
                
                if (currentMainTab === 'police' && p !== 'police') return;
                if (currentMainTab === 'news' && p !== 'news') return;
                if (currentMainTab === 'word_of_mouth' && p !== 'word_of_mouth') return;
                if (currentMainTab === 'intervention' && p !== 'intervention') return;

                visibleCount++;

                if (item.hasPin && item.lat && item.lng) {
                    heatPoints.push([item.lat, item.lng, 1.0]);
                    const marker = L.marker([item.lat, item.lng], { icon: getIcon(item.category) });
                    marker.bindPopup(`
                        <div class="font-sans min-w-[220px]">
                            <strong class="text-xs text-white block">${item.source}</strong>
                            <p class="text-[11px] text-slate-300 mt-1">${item.description}</p>
                            <div class="mt-2 text-[9px] text-slate-400 font-mono text-right border-t border-slate-800 pt-1">${formatTimestamp(item.timestamp)}</div>
                            ${item.url ? `<a href="${item.url}" target="_blank" rel="noopener noreferrer" class="block text-center mt-2 px-2 py-1.5 bg-slate-800 hover:bg-slate-700 text-amber-400 font-bold text-[10px] rounded transition">🔗 View Origin</a>` : ''}
                        </div>
                    `);
                    clusterGroup.addLayer(marker);
                }

                const card = document.createElement('div');
                card.className = `p-3 bg-slate-900 border border-slate-800 rounded-xl cursor-pointer hover:border-slate-600 transition`;
                card.innerHTML = `
                    <div class="flex justify-between items-center mb-1">
                        <p class="text-xs font-bold text-slate-200 line-clamp-1">${item.source}</p>
                        <span class="text-[9px] text-slate-500 font-mono whitespace-nowrap ml-2">${formatTimestamp(item.timestamp)}</span>
                    </div>
                    <p class="text-[11px] text-slate-400 line-clamp-2">${item.description}</p>
                    ${item.url ? `<a href="${item.url}" target="_blank" rel="noopener noreferrer" class="text-[9px] text-sky-400 hover:underline font-bold mt-1.5 inline-block" onclick="event.stopPropagation()">🔗 Direct Link</a>` : ''}
                `;
                if (item.hasPin && item.lat && item.lng) card.onclick = () => map.flyTo([item.lat, item.lng], 16);
                feedContainer.appendChild(card);
            });

            document.getElementById('active-count').innerText = `${visibleCount} records matched`;
            if (document.getElementById('heatmap-toggle').checked && heatPoints.length > 0) {
                heatLayer = L.heatLayer(heatPoints, { radius: 35, blur: 20, maxZoom: 15 }).addTo(map);
            }
        }

        onSnapshot(query(collection(db, "reports"), orderBy("timestamp", "desc"), limit(100)), (snapshot) => {
            rawReports = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            filterAndRender();
        });
        document.getElementById('heatmap-toggle').onchange = filterAndRender;

        const modal = document.getElementById('report-modal');
        const authSection = document.getElementById('auth-section');
        const reportForm = document.getElementById('hazard-form');
        
        document.getElementById('auth-btn').onclick = () => {
            if (auth.currentUser) signOut(auth);
            else { modal.classList.remove('hidden'); document.getElementById('modal-title').innerText = "Sign In Required"; }
        };
        
        // OPEN REPORT WET FLOOR & FETCH GPS
        document.getElementById('open-report-modal').onclick = () => {
            modal.classList.remove('hidden');
            document.getElementById('modal-title').innerText = "Report Wet Floor";
            
            if (navigator.geolocation) {
                navigator.geolocation.getCurrentPosition(
                    (pos) => {
                        document.getElementById('selected-lat').value = pos.coords.latitude;
                        document.getElementById('selected-lng').value = pos.coords.longitude;
                        document.getElementById('gps-status').innerHTML = '<span>📍 Exact GPS Acquired</span><span class="w-2 h-2 rounded-full bg-emerald-400"></span>';
                    },
                    (err) => {
                        document.getElementById('gps-status').innerHTML = '<span>❌ GPS Denied. Please type intersection below.</span><span class="w-2 h-2 rounded-full bg-red-500"></span>';
                    },
                    { enableHighAccuracy: true, timeout: 5000 }
                );
            }
        };

        document.getElementById('close-modal').onclick = () => modal.classList.add('hidden');

        onAuthStateChanged(auth, user => {
            if (user) {
                document.getElementById('auth-btn').innerText = 'Sign Out';
                document.getElementById('open-report-modal').classList.remove('hidden');
                authSection.classList.add('hidden');
                reportForm.classList.remove('hidden');
            } else {
                document.getElementById('auth-btn').innerText = 'Sign In';
                document.getElementById('open-report-modal').classList.add('hidden');
                authSection.classList.remove('hidden');
                reportForm.classList.add('hidden');
            }
        });

        document.getElementById('btn-login').onclick = () => signInWithEmailAndPassword(auth, document.getElementById('auth-email').value, document.getElementById('auth-pass').value).catch(e => alert(e.message));
        document.getElementById('btn-signup').onclick = () => createUserWithEmailAndPassword(auth, document.getElementById('auth-email').value, document.getElementById('auth-pass').value).catch(e => alert(e.message));

        reportForm.onsubmit = async (e) => {
            e.preventDefault();
            const desc = document.getElementById('hazard-desc').value.trim();
            const lat = document.getElementById('selected-lat').value;
            const lng = document.getElementById('selected-lng').value;
            
            if (desc.length < 10) return alert("Description too short.");
            if (!lat || !lng) return alert("Location required. Please allow GPS or select an intersection from the search drop-down.");
            
            try {
                await addDoc(collection(db, "reports"), {
                    category: document.getElementById('hazard-type').value,
                    platform: 'word_of_mouth',
                    hasPin: true,
                    lat: parseFloat(lat),
                    lng: parseFloat(lng),
                    source: `Word of Mouth • Verified Resident`,
                    description: desc,
                    url: '',
                    timestamp: serverTimestamp()
                });
                modal.classList.add('hidden');
                reportForm.reset();
                alert("Verified report published securely to map.");
            } catch (err) {
                alert("Permission Denied: Backend validation failed.");
            }
        };
    </script>
</body>
</html>
