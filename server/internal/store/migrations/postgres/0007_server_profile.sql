-- Server profile settings edited in the admin panel (description, who may
-- edit the profile's widgets ...). Key / value so new settings need no
-- schema change. The icon file lives in data/media/server_icon.png.
CREATE TABLE server_settings (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
);
