# Spotify Widgets

Spotify Widgets is a GNOME Shell extension that adds Spotify controls to the top panel, customizable desktop widgets, and optional advertisement muting.

## Main features

- Panel indicator with playback controls and track information
- Customizable overlay and desktop widgets
- Lyrics widget powered by LRCLIB
- Optional fake equalizer widgets
- Optional automatic muting of detected Spotify advertisements

## Requirements

- GNOME Shell 50
- Spotify running with MPRIS support
- Internet access for the lyrics widget

## Lyrics

Lyrics are requested from LRCLIB only when an enabled lyrics widget is present and the current track changes. The request may include the track title, artist, album, and duration to improve matching accuracy.

