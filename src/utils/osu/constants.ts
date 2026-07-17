// Matches osu! beatmap URLs in both new and old site formats:
// new: https://osu.ppy.sh/beatmapsets/{setId}#{mode}/{mapId}
// old: https://osu.ppy.sh/b/{mapId} or /s/{setId}
export const BEATMAP_URL_REGEX =
  /https?:\/\/(osu|old)\.ppy\.sh\/(beatmapsets\/(\d+)(#(osu|taiko|fruits|mania)\/(\d+))?|([bs])\/(\d+))/;

// Indices in the regex match array:
// [0] full match
// [1] subdomain (osu | old)
// [2] path after domain
// [3] beatmapSetId  (new site)
// [4] #mode/mapId   (new site, optional)
// [5] mode string   (new site, optional)
// [6] beatmapId     (new site, optional)
// [7] 'b' or 's'    (old site)
// [8] id            (old site)

export const FETCH_ATTEMPTS = 3;

export const SUPPORTED_MODES = [0, 1, 3]; // osu!standard = 0, osu!taiko = 1, osu!mania = 3
