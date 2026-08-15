/// <reference types="vite/client" />

interface ImportMetaEnv {
	readonly MAIN_VITE_SERVER_URL: string;
	// forum base for the news feed; defaults to the live forum so PTR shows real posts
	readonly MAIN_VITE_FORUM_URL: string;
	readonly MAIN_VITE_CLIENT_VERSION: string;
	// PTR realm/patch host; only set for PTR builds, live falls back to octowow.st.
	readonly MAIN_VITE_PTR_REALMLIST: string;
	// When set, sync the client from this web-seeded .torrent instead of the manifest.
	readonly MAIN_VITE_CLIENT_TORRENT_URL: string;
	// optional raid-visuals patch (patch-O.mpq); a ".sha256" sidecar drives change detection
	readonly MAIN_VITE_RAID_VISUALS_URL: string;
	// the content patch (patch-5.mpq), served outside the torrent; kept current by a ".sha256" sidecar
	readonly MAIN_VITE_CLIENT_PATCH_URL: string;
}
