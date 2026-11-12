import { getStore } from "@netlify/blobs";

// Blob stores are created per request. Creating them at module load caches an
// access token that later expires ("Token expired" errors).
// Blobs only hold files and pictures; everything else lives in the database.
export function stores() {
  return {
    files: getStore("academy-files"),
    metadata: getStore("academy-file-meta"),
    avatars: getStore({ name: "academy-avatars", consistency: "strong" }),
    legacyScores: getStore({ name: "academy-scores", consistency: "strong" }),
    legacyProfiles: getStore({ name: "academy-profiles", consistency: "strong" }),
    system: getStore({ name: "academy-system", consistency: "strong" }),
  };
}
export type Stores = ReturnType<typeof stores>;
