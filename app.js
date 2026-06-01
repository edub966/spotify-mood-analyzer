const CLIENT_ID = CONFIG.CLIENT_ID;
const REDIRECT_URI = CONFIG.REDIRECT_URI;
const SCOPES = 'user-read-recently-played user-top-read';

const API_BASE = 'https://api.spotify.com/v1';
const CACHE_TTL_MS = 5 * 60 * 1000;
const TOP_RANGES = ['short_term', 'medium_term', 'long_term'];
const TOP_TRACK_PAGE_LIMIT = 50;
const TOP_TRACK_MAX_PAGES = 4;
const RECENT_PAGE_LIMIT = 50;
const RECENT_MAX_PAGES = 3;
const TOP_ARTIST_PAGE_LIMIT = 50;
const RANGE_LABELS = {
  blended: 'Blended signal',
  recent: 'Recent plays',
  short_term: 'Last month',
  medium_term: 'Six months',
  long_term: 'All-time signal',
};

const state = {
  token: null,
  range: localStorage.getItem('analysis_range') || 'blended',
  forceRefresh: false,
  lastResults: [],
};

const el = {};

function bindElements() {
  [
    'login-btn',
    'logout-btn',
    'login-screen',
    'app-screen',
    'loading',
    'content',
    'sum-session',
    'sum-top-mood',
    'sum-tracks',
    'sum-time',
    'arc-chart',
    'track-list',
    'range-select',
    'refresh-btn',
    'status-message',
    'error-state',
    'session-explanation',
    'source-breakdown',
    'arc-subtitle',
    'arc-insights',
  ].forEach((id) => {
    el[id] = document.getElementById(id);
  });
}

function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function uniquePush(list, value) {
  if (value && !list.includes(value)) list.push(value);
}

function formatRangeLabel(range) {
  return RANGE_LABELS[range] || RANGE_LABELS.blended;
}

function getBestImage(images = []) {
  return images.find((img) => img.width >= 160 && img.width <= 360)?.url
    || images[1]?.url
    || images[0]?.url
    || '';
}

function cacheKey(url) {
  return 'spotify_cache:' + url;
}

async function spotifyFetch(path, options = {}) {
  const url = path.startsWith('https://') ? path : API_BASE + path;
  const key = cacheKey(url);

  if (!options.forceRefresh) {
    const cached = sessionStorage.getItem(key);
    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        if (Date.now() - parsed.savedAt < CACHE_TTL_MS) return parsed.data;
      } catch {
        sessionStorage.removeItem(key);
      }
    }
  }

  const res = await fetch(url, {
    headers: { Authorization: 'Bearer ' + state.token },
  });

  if (res.status === 401) {
    localStorage.removeItem('access_token');
    throw new Error('Your Spotify session expired. Please connect again.');
  }

  if (res.status === 429) {
    const retryAfter = res.headers.get('Retry-After');
    throw new Error(`Spotify rate limited this analysis${retryAfter ? ` for ${retryAfter}s` : ''}. Try refresh again shortly.`);
  }

  if (!res.ok) {
    throw new Error(`Spotify request failed (${res.status}).`);
  }

  const data = await res.json();
  sessionStorage.setItem(key, JSON.stringify({ savedAt: Date.now(), data }));
  return data;
}

function clearSpotifyCache() {
  Object.keys(sessionStorage)
    .filter((key) => key.startsWith('spotify_cache:'))
    .forEach((key) => sessionStorage.removeItem(key));
}

function setLoading(message = 'Analyzing your listening signal...') {
  if (el.loading) {
    el.loading.style.display = 'flex';
    el.loading.querySelector('p').textContent = message;
  }
  if (el.content) el.content.style.display = 'none';
  if (el['error-state']) el['error-state'].hidden = true;
  if (el['status-message']) el['status-message'].textContent = message;
  if (el['refresh-btn']) el['refresh-btn'].disabled = true;
}

function setReady(message = '') {
  if (el.loading) el.loading.style.display = 'none';
  if (el.content) el.content.style.display = 'block';
  if (el['status-message']) el['status-message'].textContent = message;
  if (el['refresh-btn']) el['refresh-btn'].disabled = false;
}

function showError(message, canRetry = true) {
  if (el.loading) el.loading.style.display = 'none';
  if (el.content) el.content.style.display = 'block';
  if (el['error-state']) {
    el['error-state'].hidden = false;
    el['error-state'].innerHTML = `
      <div class="empty-card">
        <p class="section-label">Analysis paused</p>
        <h2>${escapeHTML(message)}</h2>
        <p>Spotify only returns certain listening data through the current scopes. Reconnect or refresh if the data should be available.</p>
        ${canRetry ? '<button class="secondary-btn" type="button" id="retry-btn">Try again</button>' : ''}
      </div>`;
    const retry = document.getElementById('retry-btn');
    if (retry) retry.addEventListener('click', () => runApp({ forceRefresh: true }));
  }
  if (el['refresh-btn']) el['refresh-btn'].disabled = false;
  if (el['status-message']) el['status-message'].textContent = 'Analysis could not finish.';
}

async function generateCodeVerifier() {
  const array = new Uint8Array(64);
  crypto.getRandomValues(array);
  return btoa(String.fromCharCode(...array))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function generateCodeChallenge(verifier) {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function login() {
  const verifier = await generateCodeVerifier();
  const challenge = await generateCodeChallenge(verifier);
  localStorage.setItem('pkce_verifier', verifier);

  window.location.href = 'https://accounts.spotify.com/authorize'
    + '?client_id=' + CLIENT_ID
    + '&response_type=code'
    + '&redirect_uri=' + encodeURIComponent(REDIRECT_URI)
    + '&scope=' + encodeURIComponent(SCOPES)
    + '&code_challenge_method=S256'
    + '&code_challenge=' + challenge;
}

async function handleRedirect() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  const verifier = localStorage.getItem('pkce_verifier');
  if (!code || !verifier) return false;

  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: verifier,
    }),
  });

  const data = await res.json();
  if (data.access_token) {
    localStorage.setItem('access_token', data.access_token);
    localStorage.removeItem('pkce_verifier');
    clearSpotifyCache();
    window.history.replaceState({}, '', '/');
    showApp();
    return true;
  } else {
    showError('Spotify did not return an access token. Please try connecting again.', false);
    return true;
  }
}

async function getRecentlyPlayed(forceRefresh) {
  const items = [];
  const seen = new Set();
  let before = '';

  for (let page = 0; page < RECENT_MAX_PAGES; page += 1) {
    const suffix = before ? `&before=${encodeURIComponent(before)}` : '';
    const data = await spotifyFetch(`/me/player/recently-played?limit=${RECENT_PAGE_LIMIT}${suffix}`, { forceRefresh });
    const pageItems = data.items ?? [];
    if (!pageItems.length) break;

    pageItems.forEach((item) => {
      const key = `${item.track?.id || 'unknown'}:${item.played_at}`;
      if (!seen.has(key)) {
        seen.add(key);
        items.push(item);
      }
    });

    const oldest = pageItems[pageItems.length - 1]?.played_at;
    if (!oldest || pageItems.length < RECENT_PAGE_LIMIT) break;
    before = String(new Date(oldest).getTime() - 1);
  }

  return items;
}

async function getTopTracks(forceRefresh) {
  const responses = await Promise.all(TOP_RANGES.map(async (range) => {
    const items = [];
    let total = null;

    for (let page = 0; page < TOP_TRACK_MAX_PAGES; page += 1) {
      const offset = page * TOP_TRACK_PAGE_LIMIT;
      const data = await spotifyFetch(`/me/top/tracks?limit=${TOP_TRACK_PAGE_LIMIT}&offset=${offset}&time_range=${range}`, { forceRefresh });
      const pageItems = data.items ?? [];
      total = typeof data.total === 'number' ? data.total : total;
      items.push(...pageItems);
      if (!pageItems.length || pageItems.length < TOP_TRACK_PAGE_LIMIT || (total !== null && items.length >= total)) break;
    }

    return { range, items, total };
  }));
  return responses;
}

async function getTopArtists(forceRefresh) {
  const responses = await Promise.all(TOP_RANGES.map(async (range) => {
    const data = await spotifyFetch(`/me/top/artists?limit=${TOP_ARTIST_PAGE_LIMIT}&time_range=${range}`, { forceRefresh });
    return data.items ?? [];
  }));

  const artists = new Map();
  responses.flat().forEach((artist) => {
    if (!artists.has(artist.id)) artists.set(artist.id, artist);
  });
  return [...artists.values()];
}

function buildGenreMap(topArtists) {
  const map = {};
  topArtists.forEach((artist) => {
    map[artist.id] = artist.genres ?? [];
  });
  return map;
}

function combineTracks(recentItems, topTrackGroups, genreMap) {
  const records = new Map();

  function ensureRecord(track) {
    if (!track?.id) return null;
    if (!records.has(track.id)) {
      records.set(track.id, {
        track,
        recentPlays: [],
        topRanges: [],
        topPositions: {},
        contexts: new Set(),
      });
    }
    return records.get(track.id);
  }

  recentItems.forEach((item, index) => {
    const record = ensureRecord(item.track);
    if (!record) return;
    record.recentPlays.push({
      playedAt: item.played_at,
      order: index,
      contextType: item.context?.type || null,
    });
    if (item.context?.type) record.contexts.add(item.context.type);
  });

  topTrackGroups.forEach(({ range, items }) => {
    items.forEach((track, index) => {
      const record = ensureRecord(track);
      if (!record) return;
      uniquePush(record.topRanges, range);
      record.topPositions[range] = index + 1;
    });
  });

  return [...records.values()].map((record) => normalizeTrackRecord(record, genreMap));
}

function normalizeTrackRecord(record, genreMap) {
  const { track } = record;
  const artists = track.artists ?? [];
  const primaryArtist = artists[0];
  const genres = artists.flatMap((artist) => genreMap[artist.id] ?? []);
  const recentPlays = record.recentPlays.sort((a, b) => new Date(b.playedAt) - new Date(a.playedAt));
  const mostRecentPlay = recentPlays[0] || null;

  return {
    id: track.id,
    name: track.name,
    artist: artists.map((artist) => artist.name).join(', ') || 'Unknown artist',
    primaryArtistId: primaryArtist?.id || '',
    album: track.album?.name || '',
    albumArt: getBestImage(track.album?.images),
    releaseDate: track.album?.release_date || '',
    albumType: track.album?.album_type || '',
    totalTracks: track.album?.total_tracks || 0,
    trackNumber: track.track_number || 0,
    durationMs: track.duration_ms || 0,
    explicit: !!track.explicit,
    popularity: typeof track.popularity === 'number' ? track.popularity : 50,
    recentPlayCount: recentPlays.length,
    playedAt: mostRecentPlay?.playedAt || null,
    recentOrder: mostRecentPlay?.order ?? 999,
    contextTypes: [...record.contexts],
    topRanges: record.topRanges,
    topPositions: record.topPositions,
    genres: [...new Set(genres)].slice(0, 8),
  };
}

function filterByRange(records, range) {
  if (range === 'recent') return records.filter((record) => record.recentPlayCount > 0);
  if (TOP_RANGES.includes(range)) return records.filter((record) => record.topRanges.includes(range));
  return records;
}

function sortForRange(records, range) {
  return [...records].sort((a, b) => {
    if (range === 'recent') return a.recentOrder - b.recentOrder;
    if (TOP_RANGES.includes(range)) return (a.topPositions[range] || 999) - (b.topPositions[range] || 999);
    const aScore = a.recentPlayCount * 8 + a.topRanges.length * 14 + (100 - Math.min(...Object.values(a.topPositions), 100));
    const bScore = b.recentPlayCount * 8 + b.topRanges.length * 14 + (100 - Math.min(...Object.values(b.topPositions), 100));
    return bScore - aScore;
  });
}

function timeOfDay(isoString) {
  if (!isoString) return null;
  const hour = new Date(isoString).getHours();
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 21) return 'evening';
  if (hour >= 21 && hour < 24) return 'night';
  return 'late night';
}

function dayType(isoString) {
  if (!isoString) return null;
  const day = new Date(isoString).getDay();
  return (day === 0 || day === 6) ? 'weekend' : 'weekday';
}

function trackAgeYears(releaseDate) {
  if (!releaseDate) return null;
  const released = new Date(releaseDate);
  if (Number.isNaN(released.getTime())) return null;
  return (Date.now() - released.getTime()) / (1000 * 60 * 60 * 24 * 365.25);
}

function durationMins(ms) {
  return ms / 60000;
}

const STYLE_TAXONOMY = {
  hardClub: {
    terms: /hard house|eurodance|trance|rave|hard techno|hardgroove|makina|happy hardcore|club|xtc|ecstasy|euphoria/i,
    artists: /kettama|dj heartstring|kyle starkey|malugi|sam alfred|pegassi|x club|l\.p\. rhythm|burnr|dart|twofaced|marsolo|matroda|riordan|interplanetary criminal|soul mass transit|gaskin|silva bumpa|prospa|effy|ben hemsley|southstar|horsegiirL|salute|skin on skin/i,
  },
  classicDance: {
    terms: /born slippy|digital love|what is love|firestarter|club classic|big beat|french house|disco house/i,
    artists: /underworld|daft punk|haddaway|the prodigy|fatboy slim|basement jaxx|chemical brothers|armand van helden|massive attack|groove armada|moby|faithless|orbital|justice|lcd soundsystem/i,
  },
  bassChaos: {
    terms: /dubstep|brostep|bassline|bass music|drum and bass|dnb|jungle|grime|scary monsters|uzi work/i,
    artists: /skrillex|burial|benga|skream|rusko|nero|chase & status|pendulum|fred v|sub focus|hxg|desiigner|lil uzi vert|yeat|ken carson|playboi carti/i,
  },
  rapGrit: {
    terms: /rap|trap|drill|rage|plugg|pluggnb|hip hop|gangsta|detroit rap|atl trap|street rap/i,
    artists: /lucki|f1lthy|smokedope2016|chief keef|rio da yung|babytron|spinabenz|yungeen ace|whoppa|fastmoney|young thug|drake|dee mula|black kray|asap rocky|a\$ap|kanye|fetty wap|future|lil baby|gunna|youngboy|kodak black|travis scott|21 savage|gucci mane|jpegmafia|denzel curry|veeze|babyface ray|nudy|duwap kaine/i,
  },
  cloudRap: {
    terms: /cloud rap|pluggnb|plugg|drain|rage|slayworld|hypnagogic rap/i,
    artists: /lucki|fakemink|ecco2k|mechatok|bladee|yung lean|black kray|joeyy|2hollis|feng|smokedope2016|ian|summrs|autumn!|destroy lonely|thaiboy digital|snow strippers|osamason/i,
  },
  popSpark: {
    terms: /pop|dance pop|k-pop|kpop|hyperpop|electropop|synthpop|viral/i,
    artists: /taylor swift|newjeans|red velvet|charli xcx|dua lipa|lady gaga|ariana grande|olivia rodrigo|billie eilish|caroline polachek|pinkpantheress|carly rae jepsen|sabrina carpenter|the weeknd|marshmello|sonny fodera|swedish house mafia|alicia keys/i,
  },
  indieGlow: {
    terms: /indie|post-punk|garage rock|alternative|shoegaze|jangle pop|dream pop|college rock/i,
    artists: /two door cinema club|fontaines|the radio dept|radio dept|kings of leon|teddybears|iggy pop|the strokes|arctic monkeys|vampire weekend|phoenix|the 1975|interpol|turnstile|beach house|slowdive|my bloody valentine|alvvays|wet leg|black country new road|black midi/i,
  },
  mellowClassic: {
    terms: /folk|soft rock|yacht rock|classic rock|singer-songwriter|acoustic|americana/i,
    artists: /america|george martin|fleetwood mac|steely dan|eagles|james taylor|carole king|joni mitchell|paul simon|neil young|bob dylan|bruce springsteen|dire straits|tom petty|van morrison|simon & garfunkel/i,
  },
  rnbSoul: {
    terms: /r&b|soul|neo soul|funk|quiet storm|motown|gospel/i,
    artists: /sza|frank ocean|steve lacy|d'angelo|erykah badu|solange|daniel caesar|summer walker|usher|prince|marvin gaye|stevie wonder|curtis mayfield|anderson .paak|victoria monet|tyler the creator|brent faiyaz/i,
  },
  latinAfro: {
    terms: /reggaeton|latin|urbano|dembow|bachata|salsa|afrobeats|afropop|amapiano|dancehall/i,
    artists: /bad bunny|rauw alejandro|karol g|feid|j balvin|rosalia|shakira|peso pluma|fuerza regida|burna boy|wizkid|tems|asake|rema|ayra starr|davido|tyla|sean paul|popcaan/i,
  },
  metalPunk: {
    terms: /metal|punk|hardcore|emo|screamo|post-hardcore|metalcore|thrash|death metal|black metal|grunge/i,
    artists: /metallica|slipknot|deftones|system of a down|black sabbath|nirvana|green day|blink-182|my chemical romance|paramore|knocked loose|turnstile|idles|bad brains|minor threat|fugazi|the clash|ramones|misfits/i,
  },
  ambientFocus: {
    terms: /ambient|classical|instrumental|soundtrack|score|lo-fi|lofi|study|new age|minimalism|game/i,
    artists: /brian eno|aphex twin|boards of canada|four tet|nils frahm|max richter|hans zimmer|joe hisaishi|rachel portman|tim haywood|vegyn|floating points|jon hopkins|tycho|bonobo|khruangbin/i,
  },
  sparseAlternative: {
    terms: /experimental|art pop|hypnagogic|outsider|minimal wave|deconstructed/i,
    artists: /dean blunt|bar italia|vegyn|blood orange|king krule|james ferraro|arca|yves tumor|oneohtrix point never|laurel halo|tirzah|mount kimbie|jai paul|mk.gee/i,
  },
  emotionalElectronic: {
    terms: /emotional electronic|future garage|melodic house|progressive house|pull me out|lights burn dimmer|divine anthem/i,
    artists: /fred again|delilah|george clanton|mirror kisses|lustral|dj seinfeld|bicep|ross from friends|tourist|jamie xx|overmono|porter robinson|odesza|lane 8|ben bohmer/i,
  },
};

function styleProfile(track) {
  const text = `${track.name} ${track.artist} ${track.album} ${track.genres.join(' ')}`.toLowerCase();
  return Object.fromEntries(Object.entries(STYLE_TAXONOMY).map(([key, matcher]) => [
    key,
    matcher.terms.test(text) || matcher.artists.test(text),
  ]));
}

const DIMENSION_KEYS = [
  'energy',
  'intensity',
  'chaos',
  'emotionalDepth',
  'focus',
  'chill',
  'nostalgia',
  'mainstreamAppeal',
  'undergroundFactor',
  'replayStrength',
  'freshness',
  'momentum',
  'darkness',
  'exploration',
  'clubDrive',
  'bassPressure',
  'popPull',
  'sentimentalLift',
  'rapGrit',
  'cloudDrift',
  'indieGlow',
  'classicDance',
];

const MOOD_PROFILES = [
  { label: 'Euphoric', className: 'euphoric', color: '#35f57f', weights: { energy: 1.25, momentum: 1.15, replayStrength: 1, mainstreamAppeal: 0.45, chaos: -0.25, chill: -0.2 } },
  { label: 'Hyped', className: 'hyped', color: '#1db954', weights: { energy: 1.2, intensity: 1.1, momentum: 0.8, chaos: 0.35, focus: -0.15 } },
  { label: 'Rave', className: 'rave', color: '#00e08a', weights: { clubDrive: 1.35, energy: 0.9, intensity: 0.7, momentum: 0.65, chill: -0.35 } },
  { label: 'Club Heat', className: 'clubheat', color: '#ffcc33', weights: { clubDrive: 1.1, momentum: 0.9, replayStrength: 0.7, mainstreamAppeal: 0.35, emotionalDepth: -0.25 } },
  { label: 'Bass Rush', className: 'bassrush', color: '#ff5f7e', weights: { bassPressure: 1.35, chaos: 0.95, intensity: 0.85, energy: 0.45, nostalgia: -0.35, focus: -0.25 } },
  { label: 'Street Heat', className: 'streetheat', color: '#ff8a45', weights: { rapGrit: 1.25, intensity: 0.75, chaos: 0.55, undergroundFactor: 0.45, chill: -0.25 } },
  { label: 'Clouded', className: 'clouded', color: '#a8b4ff', weights: { cloudDrift: 1.25, emotionalDepth: 0.75, chill: 0.5, undergroundFactor: 0.35, momentum: -0.3 } },
  { label: 'Chaotic', className: 'chaotic', color: '#ff595f', weights: { chaos: 1.35, intensity: 1.1, energy: 0.65, replayStrength: 0.35, focus: -0.55, chill: -0.45 } },
  { label: 'Dark', className: 'dark', color: '#8a94a6', weights: { darkness: 1.25, emotionalDepth: 1.1, intensity: 0.35, energy: -0.35, mainstreamAppeal: -0.15 } },
  { label: 'Melancholic', className: 'melancholic', color: '#9da7ff', weights: { emotionalDepth: 1.1, nostalgia: 1, chill: 0.55, momentum: -0.45, energy: -0.35 } },
  { label: 'Focused', className: 'focused', color: '#4bd7ff', weights: { focus: 1.25, chill: 0.65, emotionalDepth: 0.45, chaos: -0.65, intensity: -0.25 } },
  { label: 'Ambient Drift', className: 'ambientdrift', color: '#9ee7ff', weights: { focus: 1.15, chill: 1, emotionalDepth: 0.35, intensity: -0.6, chaos: -0.65 } },
  { label: 'Dreamy', className: 'dreamy', color: '#65e4b3', weights: { chill: 1.1, focus: 0.85, emotionalDepth: 0.65, intensity: -0.45, chaos: -0.4 } },
  { label: 'Velvet', className: 'velvet', color: '#f3a6d7', weights: { chill: 1, sentimentalLift: 0.85, emotionalDepth: 0.7, popPull: 0.25, chaos: -0.55 } },
  { label: 'Bittersweet', className: 'bittersweet', color: '#cfa7ff', weights: { sentimentalLift: 1.15, emotionalDepth: 0.9, nostalgia: 0.6, momentum: 0.25, chaos: -0.35 } },
  { label: 'Golden Hour', className: 'goldenhour', color: '#f7c873', weights: { nostalgia: 0.85, chill: 0.9, sentimentalLift: 0.75, focus: 0.35, intensity: -0.55, chaos: -0.55 } },
  { label: 'Indie Glow', className: 'indieglow', color: '#7ddcff', weights: { indieGlow: 1.2, sentimentalLift: 0.65, energy: 0.35, nostalgia: 0.25, mainstreamAppeal: -0.25 } },
  { label: 'Nostalgic', className: 'nostalgic', color: '#b18cff', weights: { nostalgia: 0.9, replayStrength: 0.45, emotionalDepth: 0.45, intensity: -0.2, bassPressure: -0.55, freshness: -0.35 } },
  { label: 'Underground', className: 'underground', color: '#d0b7ff', weights: { undergroundFactor: 1.2, exploration: 0.9, emotionalDepth: 0.45, mainstreamAppeal: -0.8, popPull: -0.35 } },
  { label: 'Mainstream', className: 'mainstream', color: '#ffd166', weights: { mainstreamAppeal: 1.15, replayStrength: 0.7, momentum: 0.55, undergroundFactor: -0.75 } },
  { label: 'Pop Pulse', className: 'poppulse', color: '#ff9bd1', weights: { popPull: 1.2, mainstreamAppeal: 0.8, momentum: 0.55, emotionalDepth: 0.25, undergroundFactor: -0.55 } },
  { label: 'Global Heat', className: 'globalheat', color: '#ffb347', weights: { popPull: 0.95, momentum: 0.9, clubDrive: 0.55, energy: 0.55, chill: -0.2 } },
  { label: 'Dance Classic', className: 'danceclassic', color: '#ffe66d', weights: { classicDance: 1.2, clubDrive: 0.75, nostalgia: 0.45, energy: 0.45, chill: -0.25 } },
  { label: 'Fresh', className: 'fresh', color: '#8ef5ad', weights: { freshness: 1.05, momentum: 0.55, exploration: 0.35, replayStrength: -0.15, nostalgia: -0.65 } },
  { label: 'Heavy', className: 'heavy', color: '#ff6b6b', weights: { intensity: 1.2, darkness: 0.8, chaos: 0.7, energy: 0.35, chill: -0.8 } },
  { label: 'Deep Cut', className: 'deepcut', color: '#f0a500', weights: { exploration: 1.1, undergroundFactor: 0.75, emotionalDepth: 0.55, mainstreamAppeal: -0.45, freshness: -0.2 } },
];

// The model deliberately avoids deprecated audio feature endpoints. It builds
// dimension scores from Spotify metadata still available to this app, then scores
// each mood profile independently so Chill, Dark, Nostalgic, etc. can be strong.
function scoreMood(track) {
  const facts = getTrackFacts(track);
  const dimensions = calculateDimensions(track, facts);
  const profileScores = MOOD_PROFILES.map((profile) => ({
    ...profile,
    score: clamp(scoreProfile(dimensions, profile.weights) + profilePriorityAdjustment(profile.label, facts, dimensions), 0, 100),
  })).sort((a, b) => b.score - a.score);
  const winner = profileScores[0];
  const runnerUp = profileScores[1];
  const gap = winner.score - runnerUp.score;
  const score = gap < 5 && winner.score < 64 ? Math.max(35, Math.round((winner.score + runnerUp.score) / 2)) : winner.score;
  const label = gap < 5 && winner.score < 64 ? 'Balanced' : winner.label;
  const mood = label === 'Balanced'
    ? { label: 'Balanced', className: 'balanced', color: '#f0a500' }
    : winner;
  const tags = generateMoodTags(track, facts, dimensions, mood.label);
  const reasons = generateMoodReasons(track, facts, dimensions, mood.label, runnerUp.label);

  return {
    score,
    label: mood.label,
    moodClass: mood.className,
    color: mood.color,
    runnerUp: runnerUp.label,
    tags,
    reasons,
    signals: {
      ...facts.signals,
      ...dimensions,
    },
    dimensions,
    profileScores: profileScores.slice(0, 4).map((profile) => ({
      label: profile.label,
      score: profile.score,
    })),
  };
}

function getTrackFacts(track) {
  const metadata = styleProfile(track);
  const age = trackAgeYears(track.releaseDate);
  const mins = durationMins(track.durationMs);
  const tod = timeOfDay(track.playedAt);
  const dt = dayType(track.playedAt);
  const bestRank = Math.min(...Object.values(track.topPositions).filter(Number), 999);
  const inShort = track.topRanges.includes('short_term');
  const inMedium = track.topRanges.includes('medium_term');
  const inLong = track.topRanges.includes('long_term');
  const isSingle = track.albumType === 'single' || track.totalTracks === 1;
  const isDeepTrack = track.albumType === 'album' && track.totalTracks >= 8 && track.trackNumber >= Math.ceil(track.totalTracks * 0.55);

  return {
    metadata,
    age,
    mins,
    tod,
    dt,
    bestRank,
    inShort,
    inMedium,
    inLong,
    isSingle,
    isDeepTrack,
    signals: {
      popularity: track.popularity,
      duration_mins: +mins.toFixed(2),
      release_age_years: age === null ? null : +age.toFixed(1),
      time_of_day: tod,
      day_type: dt,
      top_ranges: track.topRanges,
      recent_play_count: track.recentPlayCount,
      best_top_rank: bestRank === 999 ? null : bestRank,
    },
  };
}

function calculateDimensions(track, facts) {
  const d = Object.fromEntries(DIMENSION_KEYS.map((key) => [key, 35]));
  const popularity = track.popularity ?? 50;
  const rankBoost = facts.bestRank === 999 ? 0 : clamp(35 - (facts.bestRank * 0.45), 8, 35);
  const age = facts.age;
  const mins = facts.mins;

  d.mainstreamAppeal = popularity;
  d.undergroundFactor = 100 - popularity;
  d.replayStrength = 20 + (track.recentPlayCount * 18) + (track.topRanges.length * 18) + rankBoost;
  d.momentum = 28 + (facts.inShort ? 22 : 0) + (track.recentPlayCount * 14) + (facts.isSingle ? 8 : 0) + (popularity > 70 ? 10 : 0);
  d.freshness = age === null ? 35 : clamp(100 - (age * 16), 6, 100);
  d.nostalgia = age === null ? 25 : clamp((age * 5.2) + (facts.inLong ? 14 : 0) + (facts.metadata.mellowClassic ? 14 : 0), 0, 88);
  d.energy = 36 + (facts.inShort ? 12 : 0) + (facts.isSingle ? 8 : 0) + (popularity > 65 ? 8 : 0);
  d.intensity = 28 + (track.explicit ? 18 : 0) + (facts.metadata.metalPunk || facts.metadata.rapGrit || facts.metadata.bassChaos ? 24 : 0) + (facts.metadata.hardClub ? 14 : 0);
  d.chaos = 16 + (track.explicit ? 13 : 0) + (facts.metadata.bassChaos || facts.metadata.metalPunk ? 22 : 0) + (mins < 2.25 ? 12 : 0) + (track.recentPlayCount >= 3 ? 12 : 0);
  d.emotionalDepth = 34 + (facts.isDeepTrack ? 16 : 0) + (facts.metadata.sparseAlternative || facts.metadata.emotionalElectronic || facts.metadata.rnbSoul || facts.metadata.metalPunk ? 16 : 0) + (mins > 4.7 ? 12 : 0) + (facts.inLong ? 8 : 0);
  d.focus = 35 + (facts.metadata.ambientFocus ? 30 : 0) + (mins > 4 ? 13 : 0) + (facts.tod === 'late night' || facts.tod === 'night' ? 8 : 0) - (d.chaos * 0.22);
  d.chill = 30 + (facts.metadata.rnbSoul || facts.metadata.ambientFocus || facts.metadata.mellowClassic ? 26 : 0) + (facts.metadata.cloudRap ? 10 : 0) + (mins > 4 ? 8 : 0) - (d.intensity * 0.18);
  d.darkness = 18 + (facts.metadata.metalPunk || facts.metadata.sparseAlternative ? 24 : 0) + (facts.tod === 'late night' ? 18 : 0) + (facts.inLong ? 6 : 0) + (d.emotionalDepth * 0.16);
  d.exploration = 22 + (facts.isDeepTrack ? 26 : 0) + (track.albumType === 'album' ? 12 : 0) + (popularity < 45 ? 22 : 0) + (facts.inLong ? 8 : 0) - (facts.isSingle ? 10 : 0);
  d.clubDrive = 18 + (facts.metadata.hardClub ? 42 : 0) + (facts.metadata.classicDance ? 16 : 0) + (facts.inShort ? 8 : 0);
  d.bassPressure = 14 + (facts.metadata.bassChaos ? 48 : 0) + (track.explicit ? 7 : 0);
  d.popPull = 18 + (facts.metadata.popSpark ? 42 : 0) + (facts.metadata.latinAfro ? 30 : 0) + (popularity > 72 ? 18 : 0);
  d.sentimentalLift = 22 + (facts.metadata.emotionalElectronic ? 28 : 0) + (facts.metadata.rnbSoul ? 18 : 0) + (facts.metadata.mellowClassic ? 14 : 0) + (facts.inLong ? 7 : 0) + (facts.age !== null && facts.age > 5 ? 10 : 0);
  d.rapGrit = 16 + (facts.metadata.rapGrit ? 36 : 0) + (track.explicit ? 12 : 0) + (facts.isDeepTrack ? 8 : 0) + (facts.metadata.bassChaos ? 8 : 0);
  d.cloudDrift = 14 + (facts.metadata.cloudRap ? 38 : 0) + (facts.metadata.sparseAlternative ? 18 : 0) + (facts.isDeepTrack ? 8 : 0) + (facts.inLong ? 6 : 0);
  d.indieGlow = 16 + (facts.metadata.indieGlow ? 42 : 0) + (facts.age !== null && facts.age > 8 ? 10 : 0);
  d.classicDance = 14 + (facts.metadata.classicDance ? 48 : 0) + (facts.metadata.hardClub ? 8 : 0) + (facts.age !== null && facts.age > 8 ? 12 : 0);

  if (facts.metadata.hardClub || facts.metadata.classicDance) {
    d.energy += 18;
    d.momentum += 12;
  }
  if (facts.metadata.hardClub) {
    d.energy += 22;
    d.intensity += 16;
    d.momentum += 18;
    d.replayStrength += 10;
    d.clubDrive += 22;
    d.freshness -= 10;
  }
  if (facts.metadata.hardClub || /euphoria|desire|love|feel|forever|divine|anthem|fly away|i believe/i.test(track.name)) {
    d.energy += 12;
    d.momentum += 12;
    d.emotionalDepth += 5;
    d.sentimentalLift += 12;
  }
  if (facts.metadata.bassChaos) {
    d.chaos += 26;
    d.intensity += 18;
    d.energy += 8;
    d.bassPressure += 16;
    d.nostalgia -= 24;
    d.chill -= 18;
  }
  if (facts.metadata.classicDance) {
    d.nostalgia += facts.metadata.bassChaos ? 8 : 18;
    d.intensity += 15;
    d.chaos += 10;
    d.bassPressure += 8;
    d.freshness -= 22;
  }
  if (facts.metadata.rapGrit) {
    d.rapGrit += 16;
    d.intensity += 8;
    d.nostalgia -= 14;
    d.freshness -= 8;
  }
  if (facts.metadata.cloudRap) {
    d.cloudDrift += 18;
    d.chill += 8;
    d.emotionalDepth += 8;
    d.momentum -= 6;
    d.freshness -= 12;
  }
  if (facts.metadata.indieGlow) {
    d.indieGlow += 18;
    d.sentimentalLift += 10;
    d.chill += 6;
    d.nostalgia -= 8;
  }
  if (facts.metadata.popSpark) {
    d.popPull += 28;
    d.energy += 10;
    d.momentum += 8;
    d.nostalgia -= 10;
  }
  if (facts.metadata.classicDance) {
    d.classicDance += 24;
    d.clubDrive += 10;
    d.energy += 8;
  }
  if (facts.metadata.mellowClassic) {
    d.nostalgia += 18;
    d.chill += 26;
    d.sentimentalLift += 18;
    d.focus += 10;
    d.intensity -= 20;
    d.chaos -= 20;
  }
  if (facts.metadata.sparseAlternative) {
    d.undergroundFactor += 20;
    d.exploration += 24;
    d.emotionalDepth += 16;
    d.chill += 8;
    d.nostalgia -= 10;
  }
  if (facts.metadata.emotionalElectronic) {
    d.emotionalDepth += 18;
    d.chill += 8;
    d.focus += 8;
    d.sentimentalLift += 16;
    d.momentum -= 5;
  }
  if (facts.metadata.ambientFocus) {
    d.focus += 22;
    d.nostalgia += 20;
    d.chill += 10;
    d.energy -= 8;
  }
  if (facts.metadata.popSpark) {
    d.mainstreamAppeal += 14;
    d.replayStrength += 8;
    d.popPull += 18;
    d.nostalgia += 6;
  }
  if (facts.metadata.latinAfro) {
    d.energy += 12;
    d.momentum += 14;
    d.popPull += 12;
    d.clubDrive += 8;
  }
  if (facts.metadata.metalPunk) {
    d.intensity += 24;
    d.chaos += 14;
    d.darkness += 12;
    d.energy += 8;
    d.chill -= 18;
  }
  if (facts.metadata.rnbSoul) {
    d.chill += 14;
    d.sentimentalLift += 16;
    d.emotionalDepth += 12;
    d.popPull += 6;
  }
  if (facts.tod === 'late night') {
    d.emotionalDepth += 10;
    d.chill += 8;
  }
  if (facts.dt === 'weekend') {
    d.energy += 4;
    d.momentum += 4;
  }

  return Object.fromEntries(Object.entries(d).map(([key, value]) => [key, clamp(Math.round(value), 0, 100)]));
}

function scoreProfile(dimensions, weights) {
  let positive = 0;
  let negative = 0;
  let positiveWeight = 0;
  let negativeWeight = 0;

  Object.entries(weights).forEach(([key, weight]) => {
    const value = dimensions[key] ?? 50;
    if (weight >= 0) {
      positive += value * weight;
      positiveWeight += weight;
    } else {
      negative += (100 - value) * Math.abs(weight);
      negativeWeight += Math.abs(weight);
    }
  });

  const totalWeight = positiveWeight + negativeWeight || 1;
  const raw = (positive + negative) / totalWeight;
  const shaped = raw < 50 ? raw * 0.88 : 50 + ((raw - 50) * 1.42);
  return clamp(Math.round(shaped), 0, 100);
}

function profilePriorityAdjustment(label, facts, dimensions) {
  let adjustment = 0;
  const hasSpecificStyle =
    dimensions.clubDrive >= 62 ||
    dimensions.bassPressure >= 58 ||
    dimensions.rapGrit >= 56 ||
    dimensions.cloudDrift >= 56 ||
    dimensions.indieGlow >= 56 ||
    dimensions.classicDance >= 58 ||
    dimensions.popPull >= 62 ||
    dimensions.sentimentalLift >= 64;

  if (label === 'Fresh') {
    adjustment -= facts.inLong ? 18 : 0;
    adjustment -= hasSpecificStyle ? 16 : 0;
    adjustment += dimensions.freshness >= 80 && facts.inShort ? 8 : 0;
  }

  if (label === 'Nostalgic') {
    adjustment -= hasSpecificStyle ? 18 : 0;
    adjustment -= dimensions.bassPressure >= 55 || dimensions.rapGrit >= 55 || dimensions.clubDrive >= 60 ? 16 : 0;
    adjustment += dimensions.chill >= 65 || dimensions.sentimentalLift >= 68 ? 6 : 0;
  }

  if (label === 'Clouded' && facts.metadata.cloudRap) adjustment += 16;
  if (label === 'Street Heat' && facts.metadata.rapGrit && !facts.metadata.cloudRap) adjustment += 12;
  if (label === 'Indie Glow' && facts.metadata.indieGlow) adjustment += 16;
  if (label === 'Pop Pulse' && facts.metadata.popSpark) adjustment += 18;
  if (label === 'Global Heat' && facts.metadata.latinAfro) adjustment += 18;
  if (label === 'Velvet' && facts.metadata.rnbSoul) adjustment += 18;
  if (label === 'Heavy' && facts.metadata.metalPunk) adjustment += 20;
  if (label === 'Ambient Drift' && facts.metadata.ambientFocus) adjustment += 18;
  if (label === 'Dance Classic' && facts.metadata.classicDance) adjustment += 20;
  if (label === 'Bass Rush' && facts.metadata.bassChaos) adjustment += 16;
  if (label === 'Rave' && facts.metadata.hardClub) adjustment += 12;
  if (label === 'Golden Hour' && facts.metadata.mellowClassic && dimensions.intensity < 45) adjustment += 14;

  return adjustment;
}

function generateMoodTags(track, facts, dimensions, label) {
  const tags = [];
  if (track.recentPlayCount >= 3) uniquePush(tags, label === 'Chaotic' ? 'chaotic replay' : 'repeat obsession');
  if (facts.inLong) uniquePush(tags, 'all-time favorite');
  if (facts.inMedium) uniquePush(tags, 'six-month staple');
  if (facts.inShort) uniquePush(tags, 'recent favorite');
  if (facts.isDeepTrack) uniquePush(tags, 'deep cut');
  if (dimensions.undergroundFactor >= 68) uniquePush(tags, 'underground pick');
  if (dimensions.mainstreamAppeal >= 76) uniquePush(tags, 'mainstream favorite');
  if (facts.tod === 'late night') uniquePush(tags, 'late-night pull');
  if (dimensions.intensity >= 72) uniquePush(tags, 'high-impact');
  if (dimensions.clubDrive >= 72) uniquePush(tags, 'club driver');
  if (dimensions.bassPressure >= 72) uniquePush(tags, 'bass pressure');
  if (dimensions.popPull >= 72) uniquePush(tags, 'pop crossover');
  if (dimensions.sentimentalLift >= 72) uniquePush(tags, 'sentimental lift');
  if (dimensions.rapGrit >= 70) uniquePush(tags, 'rap pressure');
  if (dimensions.cloudDrift >= 70) uniquePush(tags, 'clouded drift');
  if (dimensions.indieGlow >= 70) uniquePush(tags, 'indie glow');
  if (dimensions.classicDance >= 70) uniquePush(tags, 'dance classic');
  if (facts.mins >= 5) uniquePush(tags, 'long-form listen');
  if (facts.mins <= 2.35) uniquePush(tags, 'short burst');
  if (dimensions.freshness >= 76) uniquePush(tags, 'new rotation');
  if (dimensions.nostalgia >= 72) uniquePush(tags, 'catalog classic');
  if (track.albumType === 'album') uniquePush(tags, 'album-track energy');
  if (dimensions.emotionalDepth >= 68) uniquePush(tags, 'emotional pull');
  if (dimensions.focus >= 70 || dimensions.chill >= 72) uniquePush(tags, 'soft focus');
  if (!tags.length) uniquePush(tags, `${label.toLowerCase()} signal`);
  return tags.slice(0, 6);
}

function generateMoodReasons(track, facts, dimensions, label, runnerUp) {
  const topDims = topDimensionEntries(dimensions, 3).map(([key, value]) => `${plainSignalName(key)} ${value}/100`);
  const signals = [];
  if (facts.inLong) signals.push('appears in your long-term top tracks');
  if (facts.inMedium) signals.push('holds a six-month top-track position');
  if (facts.inShort) signals.push('is strong in your recent top tracks');
  if (track.recentPlayCount >= 2) signals.push('has repeated recent plays');
  if (facts.age !== null && facts.age > 8) signals.push('comes from an older release');
  if (facts.age !== null && facts.age < 1) signals.push('comes from a very recent release');
  if (facts.isDeepTrack) signals.push('is a later album track');
  if (track.popularity <= 40) signals.push('has lower Spotify popularity');
  if (track.popularity >= 78) signals.push('has high Spotify popularity');
  if (track.explicit) signals.push('has explicit high-impact metadata');
  if (facts.tod === 'late night') signals.push('was played late at night');

  const mainSignal = signals.slice(0, 3).join(', ') || 'matches several available metadata signals';
  return [
    `${label} because it ${mainSignal}.`,
    `Strongest dimensions: ${topDims.join(', ')}.`,
    `Runner-up mood: ${runnerUp}.`,
  ];
}

function topDimensionEntries(dimensions, limit = 3) {
  return Object.entries(dimensions)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
}

function analyzeRecords(records) {
  return records.map((track) => {
    const mood = scoreMood(track);
    return { ...track, ...mood };
  });
}

async function runApp(options = {}) {
  state.forceRefresh = !!options.forceRefresh;
  if (state.forceRefresh) clearSpotifyCache();
  state.token = localStorage.getItem('access_token');
  if (!state.token) return;

  try {
    setLoading(state.forceRefresh ? 'Refreshing Spotify signal...' : 'Analyzing your listening signal...');
    const [recentItems, topTrackGroups, topArtists] = await Promise.all([
      getRecentlyPlayed(state.forceRefresh),
      getTopTracks(state.forceRefresh),
      getTopArtists(state.forceRefresh),
    ]);

    const genreMap = buildGenreMap(topArtists);
    const combined = combineTracks(recentItems, topTrackGroups, genreMap);
    const selected = sortForRange(filterByRange(combined, state.range), state.range).slice(0, 80);

    if (!selected.length) {
      renderEmptyState();
      return;
    }

    state.lastResults = analyzeRecords(selected);
    renderApp(state.lastResults, {
      totalAvailable: combined.length,
      recentCount: recentItems.length,
      recentLimit: RECENT_PAGE_LIMIT * RECENT_MAX_PAGES,
      topCounts: Object.fromEntries(topTrackGroups.map((group) => [group.range, group.items.length])),
      topTotals: Object.fromEntries(topTrackGroups.map((group) => [group.range, group.total])),
      topRequestedLimit: TOP_TRACK_PAGE_LIMIT * TOP_TRACK_MAX_PAGES,
    });
  } catch (error) {
    showError(error.message || 'Something went wrong while analyzing Spotify data.');
  } finally {
    state.forceRefresh = false;
  }
}

function renderEmptyState() {
  setReady('No tracks returned for this range.');
  if (el['error-state']) {
    el['error-state'].hidden = false;
    el['error-state'].innerHTML = `
      <div class="empty-card">
        <p class="section-label">No data</p>
        <h2>No tracks were available for ${escapeHTML(formatRangeLabel(state.range))}.</h2>
        <p>Try a different time range or listen to a few more tracks on Spotify, then refresh the analysis.</p>
      </div>`;
  }
  ['sum-session', 'sum-top-mood', 'sum-tracks', 'sum-time'].forEach((id) => {
    if (el[id]) el[id].innerHTML = '<div class="sc-label">Waiting</div><div class="sc-value">No data</div><div class="sc-sub">Change range or refresh</div>';
  });
  if (el['arc-chart']) el['arc-chart'].innerHTML = '';
  if (el['track-list']) el['track-list'].innerHTML = '';
}

function buildSessionSummary(results) {
  const dimensionAverages = DIMENSION_KEYS.reduce((acc, key) => {
    acc[key] = Math.round(results.reduce((sum, item) => sum + item.dimensions[key], 0) / results.length);
    return acc;
  }, {});
  const moodCounts = topCounts(results.map((item) => item.label));
  const moodStrengths = results.reduce((acc, item) => {
    if (!acc[item.label]) acc[item.label] = { total: 0, count: 0, className: item.moodClass, color: item.color };
    acc[item.label].total += item.score;
    acc[item.label].count += 1;
    return acc;
  }, {});
  const dominantMood = moodCounts[0]?.[0] || 'Balanced';
  const dominantShare = (moodCounts[0]?.[1] || 0) / results.length;
  const dominantStats = moodStrengths[dominantMood] || { total: 50, count: 1, className: 'balanced', color: '#f0a500' };
  const sessionStrength = clamp(Math.round((dominantStats.total / dominantStats.count) * 0.72 + dominantShare * 35), 0, 100);
  const sessionMood = {
    label: dominantMood,
    className: dominantStats.className,
    color: dominantStats.color,
    strength: sessionStrength,
  };
  const peakTrack = results.reduce((best, item) => (item.score > best.score ? item : best), results[0]);
  const topMood = topCount(results.map((item) => item.label));
  const topTag = topCount(results.flatMap((item) => item.tags));
  const topTags = topCounts(results.flatMap((item) => item.tags)).slice(0, 3);
  const recentOnly = results.filter((item) => item.recentPlayCount > 0);
  const oldestRecent = recentOnly.length
    ? new Date(Math.min(...recentOnly.map((item) => new Date(item.playedAt).getTime())))
    : null;

  return {
    dimensionAverages,
    sessionMood,
    sessionStrength,
    peakTrack,
    topMood,
    topTag,
    topTags,
    moodCounts,
    oldestRecent,
    recentOnly,
  };
}

function topCount(values) {
  return topCounts(values)[0]?.[0] || 'Balanced';
}

function topCounts(values) {
  const counts = new Map();
  values.filter(Boolean).forEach((value) => counts.set(value, (counts.get(value) || 0) + 1));
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function renderApp(results, meta) {
  setReady(`Analyzed ${results.length} unique tracks from ${formatRangeLabel(state.range).toLowerCase()}.`);
  if (el['error-state']) el['error-state'].hidden = true;
  if (el['arc-subtitle']) {
    el['arc-subtitle'].textContent = state.range === 'recent' ? 'Most recent to oldest' : `${formatRangeLabel(state.range)} order`;
  }

  const summary = buildSessionSummary(results);
  renderSummary(summary, results, meta);
  renderInsightPanel(summary, results, meta);
  renderArc(results, summary);
  renderTrackList(results);
}

function renderSummary(summary, results) {
  const rangeLabel = formatRangeLabel(state.range);
  const windowSubtext = getWindowSubtext(summary);
  const sourceCount = new Set(results.flatMap((item) => [
    item.recentPlayCount ? 'recent' : null,
    ...item.topRanges,
  ].filter(Boolean))).size;

  el['sum-session'].innerHTML = `
    <div class="sc-label">Session mood</div>
    <div class="sc-value mood-value ${summary.sessionMood.className}">${escapeHTML(summary.sessionMood.label)}</div>
    <div class="sc-sub">mood strength ${summary.sessionStrength} / 100</div>`;

  el['sum-top-mood'].innerHTML = `
    <div class="sc-label">Peak track</div>
    <div class="sc-value sc-track-name">${escapeHTML(truncate(summary.peakTrack.name, 18))}</div>
    <div class="sc-sub">${escapeHTML(summary.peakTrack.label)} mood - score ${summary.peakTrack.score}</div>`;

  el['sum-tracks'].innerHTML = `
    <div class="sc-label">Unique tracks</div>
    <div class="sc-value">${results.length}</div>
    <div class="sc-sub">${sourceCount} listening source${sourceCount === 1 ? '' : 's'}</div>`;

  el['sum-time'].innerHTML = `
    <div class="sc-label">Listening window</div>
    <div class="sc-value">${escapeHTML(rangeLabel)}</div>
    <div class="sc-sub">${escapeHTML(windowSubtext)}</div>`;
}

function renderInsightPanel(summary, results, meta) {
  const strongest = Object.entries(summary.dimensionAverages)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([key, value]) => `${plainSignalName(key)} ${value}/100`);
  const tagCopy = summary.topTags.map(([tag, count]) => `${tag} (${count})`).join(', ');

  if (el['session-explanation']) {
    el['session-explanation'].innerHTML = `
      <p>This session reads as <strong>${escapeHTML(summary.sessionMood.label)}</strong> with <strong>${summary.sessionStrength}/100</strong> strength because that mood has the largest share of tracks and strong individual matches.</p>
      <p>Dominant dimensions: ${escapeHTML(strongest.join(', '))}. Common behavior tags: ${escapeHTML(tagCopy || summary.topTag)}.</p>
      <p class="model-note">Scores are inferred from Spotify metadata available to this app, including popularity, release date, duration, explicit flag, album position, top-track range, and recent play timing.</p>`;
  }

  if (el['source-breakdown']) {
    el['source-breakdown'].innerHTML = `
      <div><span>Recent API sample</span><strong>${formatSampleCount(meta.recentCount, null, meta.recentLimit)}</strong></div>
      <div><span>Last month sample</span><strong>${formatSampleCount(meta.topCounts.short_term, meta.topTotals.short_term, meta.topRequestedLimit)}</strong></div>
      <div><span>Six months sample</span><strong>${formatSampleCount(meta.topCounts.medium_term, meta.topTotals.medium_term, meta.topRequestedLimit)}</strong></div>
      <div><span>All-time sample</span><strong>${formatSampleCount(meta.topCounts.long_term, meta.topTotals.long_term, meta.topRequestedLimit)}</strong></div>`;
  }
}

function renderArc(results, summary) {
  const arcItems = results.slice(0, 120);
  const html = arcItems.map((item, index) => {
    const pct = clamp(item.score, 8, 100);
    const tooltipPos = pct > 72 ? 'below' : 'above';
    const edgeClass = index < 3 ? 'edge-left' : index >= arcItems.length - 3 ? 'edge-right' : '';
    return `
      <div class="arc-bar ${escapeHTML(item.moodClass)} ${tooltipPos} ${edgeClass}" style="height:${pct}%;--bar-color:${item.color}">
        <div class="arc-tooltip">${escapeHTML(truncate(item.name, 28))}<br>${escapeHTML(item.label)} - ${item.score}</div>
      </div>`;
  }).join('');
  el['arc-chart'].innerHTML = html;

  if (el['arc-insights']) {
    const moodTotal = results.length || 1;
    const distribution = summary.moodCounts.slice(0, 6).map(([mood, count]) => {
      const pct = Math.round((count / moodTotal) * 100);
      return `
        <div class="arc-mood-row">
          <span>${escapeHTML(mood)}</span>
          <div class="arc-meter"><i style="width:${pct}%"></i></div>
          <strong>${pct}%</strong>
        </div>`;
    }).join('');
    const presentMoods = new Set(summary.moodCounts.map(([mood]) => mood));
    const engineCategories = MOOD_PROFILES
      .map((profile) => `<span class="engine-pill ${profile.className}${presentMoods.has(profile.label) ? ' active' : ''}">${escapeHTML(profile.label)}</span>`)
      .join('');

    el['arc-insights'].innerHTML = `
      <div class="arc-insight-copy">
        <span class="section-label">Arc read</span>
        <p>${escapeHTML(getArcRead(results, summary))}</p>
        <div class="engine-category-list" aria-label="Mood engine categories">${engineCategories}<span class="engine-pill balanced${presentMoods.has('Balanced') ? ' active' : ''}">Balanced</span></div>
      </div>
      <div class="arc-distribution">${distribution}</div>`;
  }
}

function getWindowSubtext(summary) {
  if (state.range === 'recent') {
    return summary.oldestRecent ? `recent plays from the last ${timeSince(summary.oldestRecent)}` : 'latest Spotify play history';
  }
  if (state.range === 'short_term') return 'Spotify top-track affinity, last 4 weeks';
  if (state.range === 'medium_term') return 'Spotify top-track affinity, about 6 months';
  if (state.range === 'long_term') return 'Spotify long-term top-track affinity';
  return 'recent plays plus top-track affinity';
}

function plainSignalName(key) {
  return {
    energy: 'energy',
    intensity: 'intensity',
    chaos: 'chaos',
    emotionalDepth: 'emotional depth',
    focus: 'focus',
    chill: 'chill',
    nostalgia: 'nostalgia',
    mainstreamAppeal: 'mainstream appeal',
    undergroundFactor: 'underground factor',
    replayStrength: 'replay strength',
    freshness: 'freshness',
    momentum: 'momentum',
    darkness: 'darkness',
    exploration: 'exploration',
    clubDrive: 'club drive',
    bassPressure: 'bass pressure',
    popPull: 'pop pull',
    sentimentalLift: 'sentimental lift',
    rapGrit: 'rap grit',
    cloudDrift: 'cloud drift',
    indieGlow: 'indie glow',
    classicDance: 'classic dance',
  }[key] || key;
}

function getArcRead(results, summary) {
  const first = results.slice(0, Math.max(3, Math.ceil(results.length * 0.2)));
  const last = results.slice(-Math.max(3, Math.ceil(results.length * 0.2)));
  const firstAvg = average(first.map((item) => item.score));
  const lastAvg = average(last.map((item) => item.score));
  const delta = firstAvg - lastAvg;
  if (Math.abs(delta) < 5) {
    return `The arc is steady overall, with ${summary.topMood.toLowerCase()} tracks showing up most often.`;
  }
  if (delta > 0) {
    return `The front of this window is more energized than the deeper cuts, led by ${summary.topMood.toLowerCase()} tracks.`;
  }
  return `The deeper part of this window carries more energy than the top of the list, with ${summary.topMood.toLowerCase()} tracks leading.`;
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function formatSampleCount(count = 0, total = null, requestedLimit = null) {
  if (typeof total === 'number' && total > count) return `${count} of ${total}`;
  if (typeof requestedLimit === 'number' && count >= requestedLimit) return `${count}+`;
  return String(count);
}

function renderTrackList(results) {
  const html = results.map((item, index) => {
    const tagsHTML = item.tags.slice(0, 5).map((tag) => `<span class="tag">${escapeHTML(tag)}</span>`).join('');
    const reasons = item.reasons.map((reason) => `<li>${escapeHTML(reason)}</li>`).join('');
    const source = sourceLabel(item);
    const secondarySource = secondarySourceLabel(item);
    const imageHTML = item.albumArt
      ? `<img class="track-art" src="${escapeHTML(item.albumArt)}" alt="${escapeHTML(item.album)} album art" loading="lazy" decoding="async" fetchpriority="${index < 4 ? 'high' : 'low'}" />`
      : '<div class="track-art track-art-fallback" aria-hidden="true"></div>';

    return `
      <article class="track-card">
        ${imageHTML}
        <div class="track-info">
          <div class="track-kicker">
            <span>${escapeHTML(source)}</span>
            ${secondarySource ? `<small>${escapeHTML(secondarySource)}</small>` : ''}
          </div>
          <div class="track-name">${escapeHTML(item.name)}</div>
          <div class="track-artist">${escapeHTML(item.artist)}</div>
          <div class="track-tags">${tagsHTML}</div>
        </div>
        <div class="track-right">
          <span class="mood-chip ${escapeHTML(item.moodClass)}">${escapeHTML(item.label)}</span>
          <div class="mood-score">${item.score}/100</div>
        </div>
        <details class="track-details">
          <summary>Why this mood?</summary>
          <ul>${reasons}</ul>
        </details>
      </article>`;
  }).join('');

  el['track-list'].innerHTML = html;
}

function sourceLabel(item) {
  if (state.range === 'recent') {
    if (item.recentPlayCount > 1) return `${item.recentPlayCount} recent plays`;
    return 'Recent play';
  }
  if (state.range === 'short_term') return 'Last month top track';
  if (state.range === 'medium_term') return 'Six-month top track';
  if (state.range === 'long_term') return 'All-time top track';
  if (item.recentPlayCount > 1) return `${item.recentPlayCount} recent plays`;
  if (item.recentPlayCount === 1) return 'Recent play';
  const bestRange = bestTopRange(item);
  if (bestRange === 'short_term') return 'Last month top track';
  if (bestRange === 'medium_term') return 'Six-month top track';
  if (bestRange === 'long_term') return 'All-time top track';
  return 'Spotify track';
}

function secondarySourceLabel(item) {
  const labels = [];
  if (state.range !== 'recent' && item.recentPlayCount > 0) labels.push(item.recentPlayCount > 1 ? `${item.recentPlayCount} recent plays` : 'recent play');
  TOP_RANGES.forEach((range) => {
    if (range !== state.range && item.topRanges.includes(range)) labels.push(formatRangeLabel(range).toLowerCase());
  });
  return labels.length ? `also ${labels.slice(0, 2).join(', ')}` : '';
}

function bestTopRange(item) {
  return TOP_RANGES
    .filter((range) => item.topRanges.includes(range))
    .sort((a, b) => (item.topPositions[a] || 999) - (item.topPositions[b] || 999))[0];
}

function truncate(text, max) {
  if (!text || text.length <= max) return text || '';
  return text.slice(0, max - 3) + '...';
}

function timeSince(date) {
  const mins = Math.max(1, Math.floor((Date.now() - date.getTime()) / 60000));
  if (mins < 60) return mins + ' min';
  if (mins < 1440) return Math.floor(mins / 60) + ' hr';
  return Math.floor(mins / 1440) + ' days';
}

function showApp() {
  el['login-screen'].style.display = 'none';
  el['app-screen'].style.display = 'block';
  if (el['range-select']) el['range-select'].value = state.range;
  runApp();
}

function attachEvents() {
  el['login-btn']?.addEventListener('click', login);

  el['logout-btn']?.addEventListener('click', () => {
    localStorage.clear();
    sessionStorage.clear();
    location.reload();
  });

  el['refresh-btn']?.addEventListener('click', () => {
    runApp({ forceRefresh: true });
  });

  el['range-select']?.addEventListener('change', (event) => {
    state.range = event.target.value;
    localStorage.setItem('analysis_range', state.range);
    runApp();
  });
}

async function init() {
  bindElements();
  attachEvents();
  const handledRedirect = await handleRedirect();
  if (!handledRedirect && localStorage.getItem('access_token')) showApp();
}

init();
