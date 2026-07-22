import { ImageResponse } from "next/og";
import { SITE_NAME, SITE_TAGLINE } from "@/lib/site";

// Auto-generates the 1200×630 social card served at /opengraph-image. Next.js
// wires it into the page's Open Graph + Twitter tags automatically.
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = `${SITE_NAME} — ${SITE_TAGLINE}`;

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          background: "radial-gradient(120% 120% at 50% 0%, #221c30 0%, #0c0a12 60%)",
          color: "#f4f1fb",
          fontFamily: "sans-serif",
        }}
      >
        {/* vinyl record */}
        <div
          style={{
            display: "flex",
            width: 150,
            height: 150,
            borderRadius: "50%",
            background: "radial-gradient(circle at 50% 42%, #2a2338 0%, #0c0a12 75%)",
            border: "3px solid #4a4363",
            alignItems: "center",
            justifyContent: "center",
            marginBottom: 40,
          }}
        >
          <div
            style={{
              width: 52,
              height: 52,
              borderRadius: "50%",
              background: "#a98bff",
            }}
          />
        </div>

        <div style={{ fontSize: 108, fontWeight: 700, letterSpacing: -2 }}>
          {SITE_NAME}
        </div>
        <div style={{ fontSize: 40, color: "#a98bff", marginTop: 8 }}>
          {SITE_TAGLINE}
        </div>
        <div style={{ fontSize: 28, color: "#9a94a8", marginTop: 24 }}>
          Hear one second. Name the track.
        </div>
      </div>
    ),
    { ...size }
  );
}
