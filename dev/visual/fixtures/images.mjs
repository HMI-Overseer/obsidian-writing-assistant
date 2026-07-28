const sceneSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#324a73"/>
      <stop offset="1" stop-color="#d78b62"/>
    </linearGradient>
    <linearGradient id="water" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#1d4352"/>
      <stop offset="1" stop-color="#3d7180"/>
    </linearGradient>
  </defs>
  <rect width="640" height="400" fill="url(#sky)"/>
  <circle cx="500" cy="105" r="46" fill="#f6d39b" opacity="0.9"/>
  <path d="M0 260 L120 145 L220 245 L345 115 L490 250 L570 170 L640 245 L640 400 L0 400 Z" fill="#243448"/>
  <path d="M0 300 Q160 255 320 300 T640 295 L640 400 L0 400 Z" fill="url(#water)"/>
  <path d="M0 330 Q160 285 320 330 T640 325" fill="none" stroke="#9cc0be" stroke-width="4" opacity="0.45"/>
  <path d="M45 287 L88 245 L128 287 Z" fill="#172535"/>
  <rect x="82" y="245" width="12" height="42" fill="#172535"/>
</svg>`;

export const SCENE_IMAGE_URI = `data:image/svg+xml,${encodeURIComponent(sceneSvg)}`;
