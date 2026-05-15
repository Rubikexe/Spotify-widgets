import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Soup from 'gi://Soup?version=3.0';
import {
    Extension,
    gettext as _
} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const DEFAULT_ACCENT_COLOR = '#1DB954';


const SpotifyIndicator = GObject.registerClass(
class SpotifyIndicator extends PanelMenu.Button {

    // Keep every timeout and idle source in one place so disable() can remove
    // them even when a callback exits early or throws.
    _addTimeout(priority, interval, callback) {
        let sourceId = GLib.timeout_add(priority, interval, () => {
            try {
                let result = callback();

                if (result !== GLib.SOURCE_CONTINUE && result !== true)
                    this._sourceIds.delete(sourceId);

                return result;
            } catch (e) {
                this._sourceIds.delete(sourceId);
                return GLib.SOURCE_REMOVE;
            }
        });

        this._sourceIds.add(sourceId);
        return sourceId;
    }

    _addIdle(priority, callback) {
        let sourceId = GLib.idle_add(priority, () => {
            try {
                let result = callback();

                if (result !== GLib.SOURCE_CONTINUE && result !== true)
                    this._sourceIds.delete(sourceId);

                return result;
            } catch (e) {
                this._sourceIds.delete(sourceId);
                return GLib.SOURCE_REMOVE;
            }
        });

        this._sourceIds.add(sourceId);
        return sourceId;
    }

    _removeSource(sourceId) {
        if (!sourceId)
            return;

        try {
            GLib.source_remove(sourceId);
        } catch (e) {
        }

        this._sourceIds.delete(sourceId);
    }

    _clearSources() {
        for (let sourceId of this._sourceIds) {
            try {
                GLib.source_remove(sourceId);
            } catch (e) {
            }
        }

        this._sourceIds.clear();
    }

    _disconnectProxySignals() {
        if (!this.proxy)
            return;

        if (this._seekedSignal) {
            try {
                this.proxy.disconnectSignal(this._seekedSignal);
            } catch (e) {
            }

            this._seekedSignal = null;
        }

        if (this._proxySignal) {
            try {
                this.proxy.disconnect(this._proxySignal);
            } catch (e) {
            }

            this._proxySignal = null;
        }
    }

    // Build the panel indicator and initialize shared runtime state.
    _init(settings) {
        super._init(0.5, "Spotify Indicator");
        this.menu.actor.hide();

        this.settings = settings;
        this._sourceIds = new Set();
        this._backgroundActors = new Set();
        this._backgroundRestackedId = global.display.connect(
            "restacked",
            () => this._lowerBackgroundWidgets()
        );
        this._spotifyWatchId = 0;
        this._seekedSignal = null;
        this._proxySignal = null;
        this._scrollTimeout = null;
        this._fullText = "";
        this._scrollState = 'start-delay';
        this._positionStart = 0;
        this._positionTimestamp = 0;
        this._isPlaying = false;
        this._spotifyRunning = false;
        this._multiWidgets = [];
        this._multiSeekingState = null;
        this._multiResizingState = null;
        this._lyricsSession = new Soup.Session();
        this._lyricsTrackKey = null;
        this._lyricsText = _("Lyrics unavailable");
        this._lyricsLoading = false;
        this._lyricsRequestSerial = 0;
        this._advertisementMuteActive = false;
        this._advertisementPreviousVolume = null;
        this._volumeOsd = null;
        this._volumeOsdTimeout = null;
        this._ignoreNextDesktopWidgetsChanged = false;
        this._seeking = false;
        this._interfaceSettings = new Gio.Settings({
            schema_id: 'org.gnome.desktop.interface'
        });
        this._interfaceChangedId = this._interfaceSettings.connect(
            'changed::color-scheme',
            () => {
                if (this._popup)
                    this._createPopup();
            }
        );
        this._multiStageCaptureId = global.stage.connect(
            'captured-event',
            (actor, event) => this._handleMultiStageEvent(event)
        );
        this.box = new St.BoxLayout({
            style_class: 'panel-status-menu-box',
            reactive: true
        });

        this.icon = new St.Bin({ style_class: 'system-status-icon' });

        this.label = new St.Label({
            text: 'Spotify...',
            y_align: Clutter.ActorAlign.CENTER
        });

        this.label.clutter_text.set_ellipsize(3);

        this.textBox = new St.BoxLayout({
            clip_to_allocation: true
        });
        this.textBox.add_child(this.label);

        this.box.add_child(this.icon);
        this.box.add_child(this.textBox);

        this.add_child(this.box);

        this.connect("button-press-event", (actor, event) =>
            this._handlePanelButtonPress(event)
        );

        this.connect("captured-event", (actor, event) => {
            if (event.type() === Clutter.EventType.BUTTON_PRESS)
                return this._handlePanelButtonPress(event);

            return Clutter.EVENT_PROPAGATE;
        });
        this.menu.box.set_style(`
            padding: 0px;
            margin: 0px;
            background-color: transparent;
            border: none;
            box-shadow: none;
        `);

        this.menu.box.opacity = 255;

        this.menu.actor.set_style(`
            background: transparent;
            background-color: transparent;
            border: none;
            box-shadow: none;
            -arrow-background-color: transparent;
            -arrow-border-color: transparent;
        `);

        this._reloadStyle();

        this.connect('scroll-event', (actor, event) => {
            if (!this.proxy)
                return Clutter.EVENT_STOP;

            let direction = event.get_scroll_direction();

            if (direction === Clutter.ScrollDirection.UP)
                this._changeVolume(0.05);
            else if (direction === Clutter.ScrollDirection.DOWN)
                this._changeVolume(-0.05);

            return Clutter.EVENT_STOP;
        });

        this.connect('enter-event', () => {
            if (
                this.settings.get_string('scroll-mode') === 'hover' &&
                this._fullText &&
                !this._scrollTimeout
            ) {
                this._startScroll(this._fullText);
            }
        });

        this.connect('leave-event', () => {
            this._scheduleVolumeOsdFade(1500);

            if (this.settings.get_string('scroll-mode') === 'hover') {
                this._stopScroll();
                this.label.set_text(this._fullText);
            }
        });
        this._settingsChangedId = this.settings.connect('changed', (settings, key) => {
            if (key === 'desktop-widgets') {
                if (this._ignoreNextDesktopWidgetsChanged) {
                    this._ignoreNextDesktopWidgetsChanged = false;
                    return;
                }

                this._createMultiWidgets();
                this._updateMultiWidgets();
                return;
            }

            if (key === 'advertisement-mute-enabled') {
                this._updateAdvertisementMute();
                return;
            }

            this._reloadStyle();
            this._updateMetadata();

            if (this._fullText) {
                this._addTimeout(GLib.PRIORITY_DEFAULT, 50, () => {
                    if (!this.label)
                        return GLib.SOURCE_REMOVE;

                    let textWidth = this.label.clutter_text.get_layout().get_pixel_size()[0];
                    let maxWidth = this.settings.get_int('max-width');
                    let finalWidth = Math.min(textWidth, maxWidth);

                    this.textBox.set_style(`
                        overflow: hidden;
                        width: ${finalWidth}px;
                        max-width: ${maxWidth}px;
                    `);

                    return GLib.SOURCE_REMOVE;
                });
            }

            this._updateMultiWidgets();
        });

        this._initMpris();

    this._createMultiWidgets();
        }
    _handlePanelButtonPress(event) {
        if (!this.proxy)
            return Clutter.EVENT_PROPAGATE;

        let button = event.get_button?.();

        if (!button)
            return Clutter.EVENT_PROPAGATE;

        let eventTime = event.get_time?.() || 0;

        if (
            eventTime &&
            this._lastPanelButtonEventTime === eventTime &&
            this._lastPanelButtonEventButton === button
        )
            return Clutter.EVENT_STOP;

        if (eventTime) {
            this._lastPanelButtonEventTime = eventTime;
            this._lastPanelButtonEventButton = button;
        }

        let playBtn = this.settings.get_int("playpause-button");
        let nextBtn = this.settings.get_int("next-button");
        let prevBtn = this.settings.get_int("previous-button");
        let popupBtn = this.settings.get_int("popup-button");

        if (popupBtn !== 0 && button === popupBtn) {
            if (!this.menu.isOpen)
                this._createPopup();

            this.menu.toggle();
            return Clutter.EVENT_STOP;
        }

        if (playBtn !== 0 && button === playBtn) {
            this.proxy.call("PlayPause", null, Gio.DBusCallFlags.NONE, -1, null, null);
            return Clutter.EVENT_STOP;
        }

        if (nextBtn !== 0 && button === nextBtn) {
            this.proxy.call("Next", null, Gio.DBusCallFlags.NONE, -1, null, null);
            return Clutter.EVENT_STOP;
        }

        if (prevBtn !== 0 && button === prevBtn) {
            this.proxy.call("Previous", null, Gio.DBusCallFlags.NONE, -1, null, null);
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    }

    vfunc_event(event) {
        if (event.type() === Clutter.EventType.BUTTON_PRESS) {
            let result = this._handlePanelButtonPress(event);

            if (result === Clutter.EVENT_STOP)
                return result;
        }

        return super.vfunc_event(event);
    }

// Watch Spotify's MPRIS bus name so the UI follows player startup/shutdown.
    _initMpris() {
    this._tryInitProxy();

    this._spotifyWatchId = Gio.DBus.session.watch_name(
        'org.mpris.MediaPlayer2.spotify',
        Gio.BusNameWatcherFlags.NONE,
        () => {

            this._spotifyRunning = true;

            this._stopScroll();
            
            this.visible = true;
            this._tryInitProxy();
        },
() => {
    this._spotifyRunning = false;

        this._stopScroll();
        this._disconnectProxySignals();
        this.proxy = null;
        this._lyricsRequestSerial++;
    
        this._setDesktopSpotifyNotRunning();
    
        if (this.settings.get_boolean('hide-when-stopped')) {
            this.visible = false;
        } else {
            this.visible = true;
        this.label.set_text(_("Spotify not running"));
        
        this.label.queue_relayout();
this.textBox.queue_relayout();

this._addIdle(GLib.PRIORITY_DEFAULT, () => {

    if (!this.label)
        return GLib.SOURCE_REMOVE;

    let textWidth = this.label.clutter_text
        .get_layout()
        .get_pixel_size()[0];

    let maxWidth = this.settings.get_int('max-width');

    let finalWidth = Math.min(textWidth, maxWidth);

    this.textBox.set_style(`
        overflow: hidden;
        width: ${finalWidth}px;
        max-width: ${maxWidth}px;
    `);

    return GLib.SOURCE_REMOVE;
});
        this.icon.set_child(new St.Icon({
            gicon: this._getSpotifyIconGicon(),
            icon_size: 16,
            style: 'color: #1DB954;'
        }));
    }
}
    );
        }

        _getSpotifyIconGicon() {
            if (this._spotifyIconGicon)
                return this._spotifyIconGicon;

            let desktopIds = [
                "spotify_spotify.desktop",
                "com.spotify.Client.desktop",
                "spotify.desktop"
            ];

            if (Gio.DesktopAppInfo) {
                for (let desktopId of desktopIds) {
                    let appInfo = Gio.DesktopAppInfo.new(desktopId);
                    let icon = appInfo?.get_icon();

                    if (icon) {
                        this._spotifyIconGicon = icon;
                        return icon;
                    }
                }
            }

            this._spotifyIconGicon = new Gio.ThemedIcon({ name: "spotify" });
            return this._spotifyIconGicon;
        }

        _setDesktopSpotifyNotRunning() {
            this._fullText = _("Spotify not running");

            this._trackTitle = _("Spotify not running");
            this._trackArtist = "";
            this._trackAlbum = "";
            this._trackArtUrl = null;
            this._lyricsTrackKey = null;
            this._lyricsLoading = false;
            this._lyricsText = _("Spotify not running");
            this._updateMultiWidgets();
        }

    _getThemeColors(light, opacity = 1) {
        return light
            ? {
                background: `rgba(255,255,255,${opacity})`,
                border: 'rgba(0,0,0,0.12)',
                text: '#000000',
                button: 'rgba(0,0,0,0.06)',
                playButton: 'rgba(0,0,0,0.08)',
                hover: 'rgba(0,0,0,0.10)',
                progress: 'rgba(0,0,0,0.15)',
                tooltipBg: 'rgba(245,245,245,0.97)',
                tooltipText: '#000000',
                subtext: 'rgba(0,0,0,0.62)'
            }
            : {
                background: `rgba(30,30,30,${opacity})`,
                border: 'rgba(255,255,255,0.10)',
                text: '#ffffff',
                button: 'rgba(255,255,255,0.06)',
                playButton: 'rgba(255,255,255,0.08)',
                hover: 'rgba(255,255,255,0.12)',
                progress: 'rgba(255,255,255,0.15)',
                tooltipBg: 'rgba(45,45,45,0.95)',
                tooltipText: '#ffffff',
                subtext: 'rgba(255,255,255,0.65)'
            };
    }

    _isSystemLightTheme() {
        try {
            return this._interfaceSettings.get_string('color-scheme')
                !== 'prefer-dark';
        } catch (e) {
            return false;
        }
    }

    _getPopupThemeColors() {
        return this._getThemeColors(
            this._isSystemLightTheme(),
            this.settings.get_double('popup-bg-opacity')
        );
    }

    _getPanelProgressColor() {
        try {
            return this.settings.get_string('panel-progress-color') || DEFAULT_ACCENT_COLOR;
        } catch (e) {
            return DEFAULT_ACCENT_COLOR;
        }
    }

    _getWidgetProgressColor(config) {
        return config.progressColor || DEFAULT_ACCENT_COLOR;
    }

    _getEqualizerColor(config) {
        return config.equalizerColor || DEFAULT_ACCENT_COLOR;
    }

    // Widget definitions are stored as JSON in GSettings. Normalize every entry
    // here so older configs and partially edited configs remain usable.
    _getDesktopWidgetConfigs() {
        try {
            let configs = JSON.parse(
                this.settings.get_string('desktop-widgets')
            );

            if (!Array.isArray(configs))
                return [];

            return configs.map((config, index) => ({
                id: config.id || `widget-${index}`,
                enabled: typeof config.enabled === 'boolean'
                    ? config.enabled
                    : true,
                mode: ['desktop', 'lyrics', 'equalizer'].includes(config.mode)
                    ? config.mode
                    : 'overlay',
                opacity: typeof config.opacity === 'number'
                    ? config.opacity
                    : 0.75,
                theme: config.theme === 'light' ? 'light' : 'dark',
                x: typeof config.x === 'number' ? config.x : 100 + index * 30,
                y: typeof config.y === 'number' ? config.y : 100 + index * 30,
                width: typeof config.width === 'number'
                    ? config.width
                    : (config.mode === 'lyrics'
                        ? 360
                        : (config.mode === 'equalizer' ? 280 : 332)),
                height: typeof config.height === 'number'
                    ? config.height
                    : (config.mode === 'lyrics'
                        ? 420
                        : (config.mode === 'equalizer'
                            ? 130
                            : (config.mode === 'overlay' ? 320 : 220))),
                compactHeight: typeof config.compactHeight === 'number'
                    ? config.compactHeight
                    : null,
                equalizerStyle: ['calm', 'balanced', 'pop', 'rock', 'metal'].includes(config.equalizerStyle)
                    ? config.equalizerStyle
                    : 'balanced',
                equalizerType: ['bars', 'circle'].includes(config.equalizerType)
                    ? config.equalizerType
                    : 'bars',
                equalizerCenter: ['spotify', 'album'].includes(config.equalizerCenter)
                    ? config.equalizerCenter
                    : 'spotify',
                equalizerSmoothness: ['low', 'balanced', 'smooth', 'very-smooth'].includes(config.equalizerSmoothness)
                    ? config.equalizerSmoothness
                    : 'balanced',
                equalizerScale: typeof config.equalizerScale === 'number'
                    ? config.equalizerScale
                    : 1,
                equalizerColor: typeof config.equalizerColor === 'string'
                    ? config.equalizerColor
                    : DEFAULT_ACCENT_COLOR,
                progressColor: typeof config.progressColor === 'string'
                    ? config.progressColor
                    : DEFAULT_ACCENT_COLOR,
                lyricsFontSize: typeof config.lyricsFontSize === 'number'
                    ? config.lyricsFontSize
                    : 15,
                lyricsFontWeight: typeof config.lyricsFontWeight === 'number'
                    ? config.lyricsFontWeight
                    : 400,
                coverScale: typeof config.coverScale === 'number'
                    ? config.coverScale
                    : 1,
                textScale: typeof config.textScale === 'number'
                    ? config.textScale
                    : 1,
                progressWidth: typeof config.progressWidth === 'number'
                    ? config.progressWidth
                    : 220,
                timesScale: typeof config.timesScale === 'number'
                    ? config.timesScale
                    : 1,
                hideCover: !!config.hideCover,
                hideTitle: !!config.hideTitle,
                hideArtist: !!config.hideArtist,
                hideAlbum: !!config.hideAlbum,
                hideProgress: !!config.hideProgress,
                hideTimes: !!config.hideTimes
            }));
        } catch (e) {
            return [];
        }
    }

    _saveDesktopWidgetConfigs(configs) {
        this.settings.set_string(
            'desktop-widgets',
            JSON.stringify(configs)
        );
    }

    _updateDesktopWidgetConfig(id, patch, options = {}) {
        let configs = this._getDesktopWidgetConfigs();
        let index = configs.findIndex(config => config.id === id);

        if (index < 0)
            return;

        configs[index] = {
            ...configs[index],
            ...patch
        };

        if (options.skipRecreate)
            this._ignoreNextDesktopWidgetsChanged = true;

        this._saveDesktopWidgetConfigs(configs);
    }

    _getMultiWidgetColors(config) {
        return this._getThemeColors(
            config.theme === 'light',
            config.opacity
        );
    }

    _getMultiWidgetText(config) {
        if (!this._spotifyRunning)
            return _("Spotify not running");

        let parts = [];

        if (!config.hideArtist && this._trackArtist)
            parts.push(this._trackArtist);

        if (!config.hideTitle && this._trackTitle)
            parts.push(this._trackTitle);

        if (!config.hideAlbum && this._trackAlbum)
            parts.push(this._trackAlbum);

        return parts.length > 0
            ? parts.join(" - ")
            : "Spotify";
    }

    _getLyricsText() {
        if (!this._spotifyRunning)
            return _("Spotify not running");

        if (this._lyricsLoading)
            return _("Loading lyrics...");

        return this._lyricsText || _("Lyrics unavailable");
    }

    _buildLyricsTrackKey(title, artist, album, durationSeconds) {
        return [
            title || '',
            artist || '',
            album || '',
            durationSeconds || 0
        ].join('\u0000');
    }

    _hasEnabledLyricsWidget() {
        let hasWidget = this._getDesktopWidgetConfigs().some(config =>
            config.enabled && config.mode === 'lyrics'
        );

        return hasWidget;
    }

    // LRCLIB is queried only when an enabled lyrics widget needs a new track.
    _fetchLyricsForCurrentTrack(metadataData = null) {
        if (!this._spotifyRunning) {
            return;
        }

        if (!this._hasEnabledLyricsWidget()) {
            return;
        }

        let title = this._trackTitle || '';
        let artist = this._trackArtist || '';
        let album = this._trackAlbum || '';
        let durationSeconds = 0;

        try {
            let data = metadataData;

            if (!data && this.proxy) {
                let metadata = this.proxy.get_cached_property('Metadata');
                data = metadata ? metadata.deep_unpack() : null;
            }

            let length = data?.['mpris:length']?.deep_unpack() || 0;
            durationSeconds = length > 0
                ? Math.round(length / 1000000)
                : 0;
        } catch (e) {
        }

        let trackKey = this._buildLyricsTrackKey(
            title,
            artist,
            album,
            durationSeconds
        );

        if (trackKey === this._lyricsTrackKey)
            return;

        this._lyricsTrackKey = trackKey;
        this._lyricsRequestSerial++;

        if (!title || !artist) {
            this._lyricsLoading = false;
        this._lyricsText = _("Lyrics unavailable") + "\n\n" + _("Missing artist or title.");
            this._updateMultiWidgets();
            return;
        }

        this._lyricsLoading = true;
        this._lyricsText = _("Loading lyrics...");
        this._updateMultiWidgets();

        let params = [
            ['track_name', title],
            ['artist_name', artist]
        ];

        if (album)
            params.push(['album_name', album]);

        if (durationSeconds > 0)
            params.push(['duration', String(durationSeconds)]);

        let query = params
            .map(([key, value]) =>
                `${key}=${GLib.uri_escape_string(value, null, true)}`
            )
            .join('&');
        let url = `https://lrclib.net/api/get?${query}`;
        let message = Soup.Message.new('GET', url);
        let serial = this._lyricsRequestSerial;

        message.request_headers.append(
            'User-Agent',
            'spotify-widgets-gnome-extension/0.1 (https://lrclib.net)'
        );

        this._lyricsSession.send_and_read_async(
            message,
            GLib.PRIORITY_DEFAULT,
            null,
            (session, result) => {
                if (serial !== this._lyricsRequestSerial)
                    return;

                try {
                    let bytes = session.send_and_read_finish(result);
                    let status = message.get_status
                        ? message.get_status()
                        : message.status_code;

                    this._lyricsLoading = false;

                    if (status !== Soup.Status.OK) {
                        this._lyricsText = status === Soup.Status.NOT_FOUND
                            ? "Lyrics not found on LRCLIB."
                            : `Lyrics fetch error (${status}).`;
                        this._updateMultiWidgets();
                        return;
                    }

                    let response = new TextDecoder().decode(bytes.get_data());
                    let data = JSON.parse(response);

                    if (data.instrumental) {
                        this._lyricsText = "Instrumental track.";
                    } else {
                        this._lyricsText =
                            data.plainLyrics ||
                            this._stripSyncedLyrics(data.syncedLyrics) ||
                            "Lyrics not found on LRCLIB.";
                    }
                } catch (e) {
                    this._lyricsLoading = false;
                    this._lyricsText = "Lyrics fetch error.";
                }

                this._updateMultiWidgets();
            }
        );
    }

    _stripSyncedLyrics(lyrics) {
        if (!lyrics)
            return null;

        let text = lyrics
            .split('\n')
            .map(line => line.replace(/^\[[^\]]+\]\s*/, ''))
            .join('\n')
            .trim();

        return text.length > 0 ? text : null;
    }

        _createMultiIconButton(iconName, colors, size, iconSize, callback) {
            let icon = new St.Icon({
                icon_name: iconName,
                icon_size: iconSize,
                style: `color: ${colors.text};`
            });

            let button = new St.Button({
                child: icon,
                reactive: true,
                track_hover: true,
                x_expand: false,
                y_expand: false,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
                style: `
                    width: ${size}px;
                    height: ${size}px;
                    min-width: ${size}px;
                    min-height: ${size}px;
                    max-width: ${size}px;
                    max-height: ${size}px;
                    border-radius: ${size / 2}px;
                    background-color: ${colors.button};
                `
            });

            button.set_size(size, size);
            button._multiDragBlocked = true;
            button.set_pivot_point(0.5, 0.5);

            button.connect("button-press-event", () => {
                button.ease({
                    scale_x: 1.12,
                    scale_y: 1.12,
                    duration: 120,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD
                });

                return Clutter.EVENT_STOP;
            });

            button.connect("button-release-event", (actor, event) => {
                button.ease({
                    scale_x: 1,
                    scale_y: 1,
                    duration: 160,
                    mode: Clutter.AnimationMode.EASE_OUT_BACK
                });

                if (!event.get_button || event.get_button() === 1)
                    callback();

                return Clutter.EVENT_PROPAGATE;
            });

            return { button, icon };
        }

    _createMultiResizeButton(state, colors) {
        let icon = new St.Icon({
            icon_name: "view-fullscreen-symbolic",
            icon_size: 16,
            style: `color: ${colors.text};`
        });

        let button = new St.Button({
            child: icon,
            reactive: true,
            track_hover: true,
            x_expand: false,
            y_expand: false,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'spotify-widgets-resize-button',
            style: `
                background-color: ${colors.button};
            `
        });

        button.set_size(28, 28);
        button._multiDragBlocked = true;

        button.connect('button-press-event', (actor, event) => {
            this._beginMultiResize(event, state);
            return Clutter.EVENT_STOP;
        });

        button.connect('button-release-event', () => {
            this._finishMultiResize();
            return Clutter.EVENT_STOP;
        });

        return button;
    }

    _beginMultiResize(event, state) {
        if (!state || event.get_button?.() !== 1)
            return;

        let [stageX, stageY] = event.get_coords();

        this._multiResizingState = state;
        state.resizeStartX = stageX;
        state.resizeStartY = stageY;
        state.resizeStartWidth = state.config.width;
        state.resizeStartHeight = state.config.mode === 'overlay'
            ? (state.compact
                ? (state.config.compactHeight || state.actor.get_height())
                : state.config.height)
            : state.config.height;
    }

    _getMultiSeekTarget(event, state) {
        if (!this.proxy || !state || !state.progressBar)
            return null;

        let metadata = this.proxy.get_cached_property('Metadata');

        if (!metadata)
            return null;

        let data = metadata.deep_unpack();
        let length = data['mpris:length']?.deep_unpack() || 0;

        if (length <= 0)
            return null;

        let [stageX] = event.get_coords();
        let barX = state.progressBar.get_transformed_position()[0];
        let width = state.progressWidth || state.progressBar.get_width();

        if (width <= 0)
            return null;

        let percent = Math.max(0, Math.min(1, (stageX - barX) / width));

        return {
            data,
            target: Math.floor(length * percent)
        };
    }

    _updateMultiProgressTooltip(event, state) {
        if (!this.proxy || !state || !state.progressBar || !state.progressTooltip)
            return;

        let seek = this._getMultiSeekTarget(event, state);

        if (!seek)
            return;

        let [stageX] = event.get_coords();
        let barX = state.progressBar.get_transformed_position()[0];
        let width = state.progressWidth || state.progressBar.get_width();
        let tooltipWidth = state.progressTooltip.get_width() || 42;
        let tooltipX = Math.max(
            0,
            Math.min(width - tooltipWidth, (stageX - barX) - tooltipWidth / 2)
        );

        state.progressTooltip.set_text(this._formatTime(seek.target));
        state.progressTooltip.set_position(tooltipX, -34);
    }

    _finishMultiResize() {
        if (!this._multiResizingState)
            return;

        let state = this._multiResizingState;
        this._multiResizingState = null;

        let patch = {
            width: state.config.width
        };

        if (state.config.mode === 'lyrics')
            patch.height = state.config.height;

        if (state.config.mode === 'overlay') {
            if (state.compact)
                patch.compactHeight = state.config.compactHeight;
            else
                patch.height = state.config.height;
        }

        this._updateDesktopWidgetConfig(state.config.id, patch, {
            skipRecreate: true
        });
    }

    _beginMultiSeek(event, state) {
        let seek = this._getMultiSeekTarget(event, state);

        if (!seek)
            return;

        this._multiSeekingState = state;
        this._seeking = true;
        this._pendingSeekData = seek.data;
        this._pendingSeekTarget = seek.target;
        this._previewSeek(seek.target);
        this._updateMultiProgressTooltip(event, state);
    }

    _updateMultiSeekDrag(event) {
        let state = this._multiSeekingState;
        let seek = this._getMultiSeekTarget(event, state);

        if (!state || !seek)
            return;

        this._pendingSeekData = seek.data;
        this._pendingSeekTarget = seek.target;
        this._previewSeek(seek.target);
        this._updateMultiProgressTooltip(event, state);
    }

    _finishMultiSeek(event = null) {
        if (!this._multiSeekingState)
            return;

        if (event)
            this._updateMultiSeekDrag(event);

        this._multiSeekingState = null;
        this._finishSeek();
    }

    // Stage-level capture keeps seek and resize drags alive after the pointer
    // leaves the original widget actor.
    _handleMultiStageEvent(event) {
        let type = event.type();

        if (type === Clutter.EventType.BUTTON_RELEASE) {
            if (this._multiSeekingState) {
                this._finishMultiSeek(event);
                return Clutter.EVENT_STOP;
            }

            if (this._multiResizingState) {
                this._finishMultiResize();
                return Clutter.EVENT_STOP;
            }
        }

        if (type === Clutter.EventType.MOTION) {
            if (this._multiSeekingState) {
                this._updateMultiSeekDrag(event);
                return Clutter.EVENT_STOP;
            }

            if (this._multiResizingState) {
                let state = this._multiResizingState;
                let eventState = event.get_state();

                if (!(eventState & Clutter.ModifierType.BUTTON1_MASK)) {
                    this._finishMultiResize();
                    return Clutter.EVENT_PROPAGATE;
                }

                let [stageX, stageY] = event.get_coords();
                let resizeMinWidth = state.config.mode === 'lyrics'
                    ? 220
                    : (state.config.mode === 'overlay' ? 260 : 240);
                let resizeMinHeight = state.config.mode === 'lyrics'
                    ? 180
                    : (state.config.mode === 'overlay'
                        ? (state.compact ? 110 : 260)
                        : 80);
                let resizeMaxHeight = state.config.mode === 'lyrics'
                    ? 900
                    : (state.config.mode === 'overlay' ? (state.compact ? 110 : 360) : 520);
                let newWidth = Math.max(
                    resizeMinWidth,
                    Math.min(700, state.resizeStartWidth + stageX - state.resizeStartX)
                );

                state.config.width = Math.floor(newWidth);

                if (state.config.mode === 'lyrics' || state.config.mode === 'overlay') {
                        let newHeight = Math.max(
                                resizeMinHeight,
                                Math.min(
                                    resizeMaxHeight,
                                    state.resizeStartHeight + stageY - state.resizeStartY
                            )
                        );

                        if (state.config.mode === 'overlay' && state.compact)
                            state.config.compactHeight = 110;
                        else
                            state.config.height = Math.floor(newHeight);
                        if (state.config.mode === 'lyrics')
                            this._applyLyricsLayout(state);
                        else {
                            this._applyMultiOverlayLayout(state);
                            this._updateMultiWidgetProgress();
                        }
                    } else {
                        this._applyMultiOverlayLayout(state);
                        this._updateMultiWidgetProgress();
                }

                return Clutter.EVENT_STOP;
            }
        }

        return Clutter.EVENT_PROPAGATE;
    }

    // Overlay widgets scale their content with height; compact mode deliberately
    // keeps a fixed height so the one-line layout cannot collapse.
    _applyMultiOverlayLayout(state) {
        if (!state || state.config.mode !== 'overlay')
            return;

        let colors = this._getMultiWidgetColors(state.config);
        let borderOpacity = state.config.theme === 'light'
            ? Math.min(0.12, state.config.opacity)
            : Math.min(0.08, state.config.opacity);
        let border = state.config.theme === 'light'
            ? `rgba(0,0,0,${borderOpacity})`
            : `rgba(255,255,255,${borderOpacity})`;
        let width = Math.max(260, state.config.width);
        let minOverlayHeight = state.compact ? 110 : 260;
        let maxOverlayHeight = state.compact ? 110 : 360;
        let height = Math.max(minOverlayHeight, state.config.height);
        let actorHeight = state.compact
            ? 110
            : height;

        actorHeight = Math.max(minOverlayHeight, Math.min(maxOverlayHeight, Math.floor(actorHeight)));

        let baseHeight = state.compact ? 96 : 320;
        let heightScale = Math.max(0.72, Math.min(1.18, actorHeight / baseHeight));
        let padding = state.compact
            ? `${Math.round(2 * heightScale)}px 8px ${Math.round(6 * heightScale)}px 8px`
            : `${Math.round(12 * heightScale)}px 16px ${Math.round(16 * heightScale)}px 16px`;
        if (state.contentBox) {
            state.contentBox.set_style(`
                padding: ${padding};
                width: ${width}px;
                spacing: ${Math.round((state.compact ? 4 : 8) * heightScale)}px;
            `);
            state.contentBox.set_position(0, 0);
            state.contentBox.set_width(width);
        }

        if (state.cover) {
            state.cover.visible = !state.compact;
            state.cover.set_icon_size(
                Math.max(48, Math.min(width - 96, Math.round(150 * heightScale)))
            );
        }

        if (state.timeBox)
            state.timeBox.visible = !state.compact;

        if (state.timeBox) {
            state.timeBox.translation_y = state.compact ? 0 : 5;
            state.timeBox.set_style(`
                padding-right: ${state.compact ? 0 : 36}px;
            `);
        }

        if (state.controlsRow)
            state.controlsRow.translation_y = state.compact ? 0 : 4;

        if (state.progressBar) {
            let progressHeight = Math.max(4, Math.min(7, Math.round(6 * heightScale)));
            let progressWidth = Math.max(40, width - (state.compact ? 164 : 132));
            state.progressWidth = progressWidth;
            state.progressHeight = progressHeight;
            state.progressBar.set_size(progressWidth, progressHeight);
            state.progressBar.set_style(`
                width: ${progressWidth}px;
                min-width: ${progressWidth}px;
                max-width: ${progressWidth}px;
                height: ${progressHeight}px;
                background: ${colors.progress};
            `);
            state.progressBar.translation_y = state.compact ? 0 : 1.4;
        }

        if (state.timeStart && state.timeEnd) {
            let timeFontSize = Math.max(11, Math.min(14, Math.round(13 * heightScale)));
            let timeWidth = Math.max(30, Math.min(38, Math.round(34 * heightScale)));
            let timeStyle = `
                font-size: ${timeFontSize}px;
                color: ${colors.text};
            `;

            state.timeStart.width = timeWidth;
            state.timeEnd.width = timeWidth;
            state.timeStart.set_style(timeStyle);
            state.timeEnd.set_style(timeStyle);
        }

        if (state.progressThumb) {
            state.progressThumbSize = Math.max(8, Math.min(12, Math.round(11 * heightScale)));
            state.progressThumb.set_style(`
                width: ${state.progressThumbSize}px;
                height: ${state.progressThumbSize}px;
                background: ${colors.text};
            `);
        }

        if (state.progressThumb && state.compact)
            state.progressThumb.visible = false;

        if (state.progressTooltip && state.compact)
            state.progressTooltip.visible = false;

        if (state.header && state.lockButton && state.compactButton) {
            state.header.remove_all_children();

            if (state.cover && state.cover.get_parent())
                state.cover.get_parent().remove_child(state.cover);

            if (state.label && state.label.get_parent())
                state.label.get_parent().remove_child(state.label);

            if (state.compact) {
                state.header.y_align = Clutter.ActorAlign.CENTER;
                state.header.add_child(state.lockButton);

                if (state.label) {
                    state.label.x_expand = true;
                    state.label.x_align = Clutter.ActorAlign.CENTER;
                    state.label.set_style(`
                        color: ${colors.text};
                        font-size: ${Math.max(12, Math.min(18, Math.round(16 * heightScale)))}px;
                        max-width: ${Math.max(120, state.config.width - 90)}px;
                        margin-top: ${Math.round(10 * heightScale)}px;
                    `);
                    state.header.add_child(state.label);
                } else {
                    state.header.add_child(new St.Widget({
                        x_expand: true
                    }));
                }

                state.header.add_child(state.compactButton);
            } else {
                state.header.y_align = Clutter.ActorAlign.START;
                state.lockButton.y_align = Clutter.ActorAlign.START;
                state.compactButton.y_align = Clutter.ActorAlign.START;
                state.header.add_child(state.lockButton);
                state.header.add_child(new St.Widget({
                    x_expand: true
                }));

                if (state.cover)
                    state.header.add_child(state.cover);

                state.header.add_child(new St.Widget({
                    x_expand: true
                }));
                state.header.add_child(state.compactButton);

                if (state.label) {
                    state.label.x_expand = false;
                    state.label.x_align = Clutter.ActorAlign.CENTER;
                    state.label.set_style(`
                        color: ${colors.text};
                        font-size: ${Math.max(12, Math.min(18, Math.round(16 * heightScale)))}px;
                        max-width: ${Math.max(120, state.config.width - 32)}px;
                        margin-top: ${Math.round(12 * heightScale)}px;
                    `);
                        (state.contentBox || state.actor).insert_child_at_index(state.label, 1);
                }
            }
        }

        if (state.prevButton && state.playButton && state.nextButton) {
            let buttonSize = Math.max(36, Math.min(52, Math.round(48 * heightScale)));
            let iconSize = Math.max(20, Math.min(30, Math.round(28 * heightScale)));
            let buttonStyle = `
                width: ${buttonSize}px;
                height: ${buttonSize}px;
                min-width: ${buttonSize}px;
                min-height: ${buttonSize}px;
                max-width: ${buttonSize}px;
                max-height: ${buttonSize}px;
                border-radius: ${buttonSize / 2}px;
                background-color: ${colors.button};
            `;

            state.prevButton.set_size(buttonSize, buttonSize);
            state.playButton.set_size(buttonSize, buttonSize);
            state.nextButton.set_size(buttonSize, buttonSize);
            state.prevButton.set_style(buttonStyle);
            state.playButton.set_style(buttonStyle);
            state.nextButton.set_style(buttonStyle);

            if (state.prevIcon)
                state.prevIcon.set_icon_size(iconSize);
            if (state.playIcon)
                state.playIcon.set_icon_size(iconSize);
            if (state.nextIcon)
                state.nextIcon.set_icon_size(iconSize);
        }

        if (state.resizeButton && state.controlsRow && state.timeBox) {
            if (state.resizeButton.get_parent())
                state.resizeButton.get_parent().remove_child(state.resizeButton);

            if (state.controlsSpacer)
                state.controlsSpacer.visible = false;

            state.resizeButton.translation_x = 2;
            state.resizeButton.translation_y = 3;
            state.actor.add_child(state.resizeButton);
            let resizeButtonX = state.compact ? width - 36 : width - 36;
            let resizeButtonY = state.compact ? actorHeight - 36 : actorHeight - 36;

            state.resizeButton.set_position(
                resizeButtonX,
                resizeButtonY
            );
        }

        if (state.lockButton && state.compactButton) {
            let buttonOffset = state.compact ? 4 : 0;

            state.lockButton.translation_y = buttonOffset;
            state.compactButton.translation_y = buttonOffset;
        }

        state.actor.set_style(`
            background-color: ${colors.background};
            border: 1px solid ${border};
            width: ${width}px;
            height: ${actorHeight}px;
        `);
        state.actor.set_size(width, actorHeight);

        state.actor.queue_relayout();
    }

    _createMultiWidgets() {
        let runtimeStates = new Map();

        if (this._multiWidgets) {
            this._multiWidgets.forEach(state => {
                runtimeStates.set(state.id, {
                    compact: state.compact,
                    locked: state.locked
                });
            });
        }

        this._destroyMultiWidgets();

        let configs = this._getDesktopWidgetConfigs();

        configs.forEach(config => {
            if (!config.enabled)
                return;

            let state = null;

            try {
                state = this._createMultiWidget(config);
            } catch (e) {
                return;
            }

            if (state) {
                let runtime = runtimeStates.get(state.id);

                if (runtime && state.config.mode === 'overlay') {
                    state.compact = runtime.compact;
                    state.locked = runtime.locked;

                    if (state.compactIcon) {
                        state.compactIcon.set_icon_name(
                            state.compact
                                ? "pan-down-symbolic"
                                : "pan-up-symbolic"
                        );
                    }

                    if (state.lockIcon) {
                        state.lockIcon.set_icon_name(
                            state.locked
                                ? "changes-prevent-symbolic"
                                : "changes-allow-symbolic"
                        );
                    }

                    this._applyMultiOverlayLayout(state);
                }

                this._multiWidgets.push(state);
            }
        });

        this._updateMultiWidgets();
        this._startProgressUpdater();
    }
        // Desktop-style widgets should behave like wallpaper decorations: they
        // stay below normal windows and are restacked after Shell changes.
        _trackBackgroundActor(actor) {
            this._backgroundActors.add(actor);
            actor.connect("destroy", () => {
                this._backgroundActors.delete(actor);
            });
            this._lowerBackgroundActor(actor);
        }

        _lowerBackgroundActor(actor) {
            if (!actor || actor.get_parent() !== global.window_group)
                return;

            let windowActors = global.get_window_actors()
                .filter(windowActor => windowActor.get_parent() === global.window_group);

            if (windowActors.length === 0) {
                global.window_group.set_child_above_sibling(actor, null);
                return;
            }

            let children = global.window_group.get_children();
            let bottomWindowActor = windowActors[0];
            let bottomIndex = children.indexOf(bottomWindowActor);

            for (let windowActor of windowActors) {
                let index = children.indexOf(windowActor);

                if (index >= 0 && (bottomIndex < 0 || index < bottomIndex)) {
                    bottomWindowActor = windowActor;
                    bottomIndex = index;
                }
            }

            global.window_group.set_child_below_sibling(actor, bottomWindowActor);
        }

        _lowerBackgroundWidgets() {
            for (let actor of this._backgroundActors)
                this._lowerBackgroundActor(actor);
        }



    _destroyMultiWidgets() {
        this._stopEqualizerUpdater();

        if (!this._multiWidgets)
            this._multiWidgets = [];

        this._multiWidgets.forEach(state => {
            if (state.actor)
                state.actor.destroy();
        });

        this._multiWidgets = [];
    }

        _addMultiWidgetToBackground(actor) {
            global.window_group.add_child(actor);
            this._trackBackgroundActor(actor);
        }

        _getEqualizerProfile(style) {
        switch (style) {
            case 'calm':
                return { min: 6, max: 34, speed: 0.55, jitter: 0.10 };
            case 'pop':
                return { min: 8, max: 68, speed: 0.95, jitter: 0.24 };
            case 'rock':
                return { min: 10, max: 82, speed: 1.15, jitter: 0.30 };
            case 'metal':
                return { min: 12, max: 98, speed: 1.45, jitter: 0.38 };
            case 'balanced':
            default:
                return { min: 8, max: 54, speed: 0.78, jitter: 0.18 };
        }
    }

    _getCircleEqualizerProfile(style, maxHeight) {
        let profile = this._getEqualizerProfile(style);
        let minRatio;
        let maxRatio;

        switch (style) {
            case 'calm':
                minRatio = 0.16;
                maxRatio = 0.38;
                break;
            case 'pop':
                minRatio = 0.22;
                maxRatio = 0.68;
                break;
            case 'rock':
                minRatio = 0.26;
                maxRatio = 0.82;
                break;
            case 'metal':
                minRatio = 0.30;
                maxRatio = 1.0;
                break;
            case 'balanced':
            default:
                minRatio = 0.15;
                maxRatio = 0.55;
                break;
        }

        return {
            min: Math.max(4, Math.round(maxHeight * minRatio)),
            max: Math.max(8, Math.round(maxHeight * maxRatio)),
            speed: profile.speed,
            jitter: profile.jitter
        };
    }

    _getEqualizerInterval(smoothness) {
        switch (smoothness) {
            case 'low':
                return 140;
            case 'smooth':
                return 60;
            case 'very-smooth':
                return 30;
            case 'balanced':
            default:
                return 100;
        }
    }

    // Equalizers use lightweight preset animation instead of sampling audio.
    _createEqualizerWidget(config) {
        let colors = this._getMultiWidgetColors(config);
        let equalizerColor = this._getEqualizerColor(config);
        let borderOpacity = config.theme === 'light'
            ? Math.min(0.12, config.opacity)
            : Math.min(0.08, config.opacity);
        let border = config.theme === 'light'
            ? `rgba(0,0,0,${borderOpacity})`
            : `rgba(255,255,255,${borderOpacity})`;
        let scale = Math.max(0.1, config.equalizerScale);
        let width = Math.max(80, Math.round(config.width * scale));
        let height = Math.max(48, Math.round(config.height * scale));
        let isCircle = config.equalizerType === 'circle';
        let barCount = isCircle ? 24 : 18;
        let gap = Math.max(2, Math.round(5 * scale));
        let innerWidth = Math.max(1, width - 32);
        let hasLabel = !(config.hideTitle && config.hideArtist && config.hideAlbum);
        let labelHeight = hasLabel ? Math.max(18, Math.round(24 * scale)) : 0;
        let innerHeight = Math.max(24, height - 32 - labelHeight);
        let barWidth = Math.max(3, Math.floor((innerWidth - gap * (barCount - 1)) / barCount));

        let actor = new St.BoxLayout({
            vertical: true,
            reactive: false,
            style_class: 'spotify-widgets-equalizer-widget',
            style: `
                background-color: ${colors.background};
                border: 1px solid ${border};
                width: ${width}px;
                height: ${height}px;
                spacing: ${hasLabel ? Math.max(4, Math.round(8 * scale)) : 0}px;
            `
        });

        actor.set_position(config.x, config.y);

        let equalizerLabel = null;

        if (hasLabel) {
            equalizerLabel = new St.Label({
                text: this._getMultiWidgetText(config),
                x_align: Clutter.ActorAlign.CENTER,
                style_class: 'spotify-widgets-equalizer-label',
                style: `
                    color: ${colors.text};
                    font-size: ${Math.max(9, Math.round(14 * scale))}px;
                    max-width: ${innerWidth}px;
                `
            });

            equalizerLabel.clutter_text.set_line_alignment(Clutter.ActorAlign.CENTER);
            equalizerLabel.clutter_text.set_ellipsize(3);
            equalizerLabel.clutter_text.set_single_line_mode(true);
            actor.add_child(equalizerLabel);
        }

        let barsRow = isCircle
            ? new St.Widget({
                layout_manager: new Clutter.FixedLayout(),
                x_expand: true,
                y_expand: true,
                style: `
                    width: ${innerWidth}px;
                    height: ${innerHeight}px;
                `
            })
            : new St.BoxLayout({
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.END,
                x_expand: true,
                y_expand: true,
                style: `spacing: ${gap}px;`
            });

        let state = {
            id: config.id,
            config,
            actor,
            equalizerLabel,
            equalizerType: config.equalizerType,
            equalizerCenter: config.equalizerCenter,
            equalizerCenterActor: null,
            equalizerCenterSize: 0,
            equalizerBars: [],
            equalizerBarWidths: [],
            equalizerHeights: [],
            equalizerPhase: Math.random() * Math.PI * 2,
            equalizerMaxHeight: isCircle
                ? Math.max(14, Math.floor(Math.min(innerWidth, innerHeight) * 0.32))
                : innerHeight,
            equalizerScale: scale,
            equalizerCenterX: innerWidth / 2 + (isCircle ? Math.round(12 * scale) : 0),
            equalizerCenterY: innerHeight / 2 + (isCircle ? Math.round(12 * scale) : 0),
            equalizerRadius: Math.max(24, Math.floor(Math.min(innerWidth, innerHeight) * 0.34)),
            equalizerTick: 0,
            equalizerTimeout: null
        };

        if (isCircle) {
            let centerSize = Math.max(34, Math.floor(Math.min(innerWidth, innerHeight) * 0.70));
            let center = new St.Bin({
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
                style: `
                    width: ${centerSize}px;
                    height: ${centerSize}px;
                    border-radius: ${Math.floor(centerSize / 2)}px;
                `
            });
            center.set_size(centerSize, centerSize);

            state.equalizerCenterActor = center;
            state.equalizerCenterSize = centerSize;
            this._updateEqualizerCenter(state);
            barsRow.add_child(center);
        }

        for (let i = 0; i < barCount; i++) {
            let angle = (Math.PI * 2 * i) / barCount - Math.PI / 2;
            let circleBarWidth = Math.max(4, Math.round(5 * scale));
            let bar = new St.Widget({
                y_align: isCircle
                    ? Clutter.ActorAlign.START
                    : Clutter.ActorAlign.END,
                style: `
                    width: ${isCircle ? circleBarWidth : barWidth}px;
                    height: 6px;
                    min-width: ${isCircle ? circleBarWidth : barWidth}px;
                    max-width: ${isCircle ? circleBarWidth : barWidth}px;
                    background-color: ${equalizerColor};
                    border-radius: ${Math.max(2, Math.floor((isCircle ? circleBarWidth : barWidth) / 2))}px;
                `
            });

            bar.set_size(isCircle ? circleBarWidth : barWidth, 6);

            if (isCircle) {
                bar.set_pivot_point(0.5, 0);
                bar.set_rotation_angle(Clutter.RotateAxis.Z_AXIS, angle * 180 / Math.PI - 90);
            }

            barsRow.add_child(bar);
            state.equalizerBars.push(bar);
            state.equalizerBarWidths.push(isCircle ? circleBarWidth : barWidth);
            state.equalizerHeights.push(6);
        }

        actor.add_child(barsRow);
        this._addMultiWidgetToBackground(actor);
        this._updateEqualizerWidget(state);
        this._startEqualizerUpdater(state);

        return state;
    }

    _startEqualizerUpdater(state) {
        if (!state || state.config.mode !== 'equalizer')
            return;

        this._stopEqualizerUpdater(state);

        state.equalizerTimeout = this._addTimeout(
            GLib.PRIORITY_DEFAULT,
            this._getEqualizerInterval(state.config.equalizerSmoothness),
            () => {
                this._updateEqualizerWidget(state);

                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    _stopEqualizerUpdater(state = null) {
        if (state) {
            if (state.equalizerTimeout) {
                this._removeSource(state.equalizerTimeout);
                state.equalizerTimeout = null;
            }

            return;
        }

        if (!this._multiWidgets)
            return;

        this._multiWidgets.forEach(state => {
            this._stopEqualizerUpdater(state);
        });
    }

    _updateEqualizerWidget(state) {
        if (!state || state.config.mode !== 'equalizer' || !state.equalizerBars)
            return;

        state.equalizerTick++;

        let profile = state.equalizerType === 'circle'
            ? this._getCircleEqualizerProfile(state.config.equalizerStyle, state.equalizerMaxHeight)
            : this._getEqualizerProfile(state.config.equalizerStyle);
        let equalizerColor = this._getEqualizerColor(state.config);

        state.equalizerBars.forEach((bar, index) => {
            let target;

            if (this._isPlaying) {
                let wave = (Math.sin(
                    state.equalizerTick * profile.speed + index * 0.72 + state.equalizerPhase
                ) + 1) / 2;
                let pulse = (Math.sin(
                    state.equalizerTick * profile.speed * 0.47 + index * 1.31
                ) + 1) / 2;
                let jitter = Math.random() * profile.jitter;
                let mix = Math.min(1, wave * 0.68 + pulse * 0.32 + jitter);

                target = profile.min + mix * (profile.max - profile.min);
            } else {
                target = 5;
            }

            target = Math.min(state.equalizerMaxHeight, Math.max(3, target));
            state.equalizerHeights[index] += (target - state.equalizerHeights[index]) * 0.35;
            let height = Math.round(state.equalizerHeights[index]);
            let width = state.equalizerBarWidths[index] || bar.get_width() || 4;

            bar.set_height(height);
            bar.set_style(`
                width: ${width}px;
                height: ${height}px;
                min-width: ${width}px;
                max-width: ${width}px;
                background-color: ${equalizerColor};
                border-radius: ${Math.max(2, Math.floor(width / 2))}px;
            `);

            if (state.equalizerType === 'circle') {
                let angle = (Math.PI * 2 * index) / state.equalizerBars.length - Math.PI / 2;
                let distance = state.equalizerRadius;
                let x = state.equalizerCenterX + Math.cos(angle) * distance - bar.get_width() / 2;
                let y = state.equalizerCenterY + Math.sin(angle) * distance;

                bar.set_position(Math.round(x), Math.round(y));
            }
        });
    }

    _updateEqualizerCenter(state) {
        if (!state || !state.equalizerCenterActor)
            return;

        let actor = state.equalizerCenterActor;
        let [width, height] = actor.get_size();
        let baseSize = Math.max(1, state.equalizerCenterSize || Math.min(width, height));
        let spotifyLogoSize = Math.round(baseSize * 1.25);
        let isAlbumCenter = state.equalizerCenter === 'album' && this._trackArtUrl;
        let size = isAlbumCenter ? baseSize : spotifyLogoSize;
        let equalizerColor = this._getEqualizerColor(state.config);

        actor.set_size(size, size);
        actor.set_position(
            Math.round(state.equalizerCenterX - size / 2),
            Math.round(state.equalizerCenterY - size / 2 - 1)
        );

        let baseStyle = `
            width: ${size}px;
            height: ${size}px;
            border-radius: ${Math.floor(size / 2)}px;
        `;

        if (isAlbumCenter) {
            actor.set_child(null);
            actor.set_style(`
                ${baseStyle}
                border: 5px solid ${equalizerColor};
                background-image: url("${this._trackArtUrl}");
                background-size: cover;
                background-position: center;
            `);

            return;
        }

        actor.set_style(baseStyle);
        actor.set_child(new St.Icon({
            gicon: this._getSpotifyIconGicon(),
            icon_size: size,
            style: `color: ${equalizerColor};`
        }));
    }

    _getLyricsTitle() {
        if (!this._spotifyRunning)
            return _("Spotify not running");

        let parts = [];

        if (this._trackArtist)
            parts.push(this._trackArtist);

        if (this._trackTitle)
            parts.push(this._trackTitle);

        return parts.length > 0 ? parts.join(" - ") : "Spotify";
    }

    _applyLyricsLayout(state) {
        if (!state || state.config.mode !== 'lyrics')
            return;

        let colors = this._getMultiWidgetColors(state.config);
        let borderOpacity = state.config.theme === 'light'
            ? Math.min(0.12, state.config.opacity)
            : Math.min(0.08, state.config.opacity);
        let border = state.config.theme === 'light'
            ? `rgba(0,0,0,${borderOpacity})`
            : `rgba(255,255,255,${borderOpacity})`;
        let width = Math.max(220, state.config.width);
        let height = Math.max(180, state.config.height);
        let innerWidth = Math.max(1, width - 32);
        let viewportHeight = Math.max(1, height - 104);

        state.actor.set_style(`
            background-color: ${colors.background};
            border: 1px solid ${border};
            width: ${width}px;
            height: ${height}px;
            spacing: 10px;
        `);

        if (state.lyricsTitle) {
            state.lyricsTitle.set_style(`
                color: ${colors.text};
                max-width: ${innerWidth}px;
            `);
        }

        if (state.lyricsViewport) {
            state.lyricsViewport.set_style(`
                width: ${innerWidth}px;
                height: ${viewportHeight}px;
            `);
        }

        if (state.lyricsLabel) {
            state.lyricsLabel.set_style(`
                color: ${colors.text};
                font-size: ${state.config.lyricsFontSize}px;
                font-weight: ${state.config.lyricsFontWeight};
                width: ${innerWidth}px;
            `);
        }

        if (state.lyricsFooter) {
            state.lyricsFooter.y_align = Clutter.ActorAlign.CENTER;
            state.lyricsFooter.set_style(`
                color: ${colors.subtext};
                max-width: ${innerWidth}px;
            `);
        }

        if (state.resizeButton) {
            state.resizeButton.translation_x = 0;
            state.resizeButton.translation_y = 0;
        }

        state.actor.queue_relayout();
    }

    // Lyrics widgets are interactive overlay actors with manual scrolling.
    _createLyricsWidget(config) {
        let colors = this._getMultiWidgetColors(config);
        let borderOpacity = config.theme === 'light'
            ? Math.min(0.12, config.opacity)
            : Math.min(0.08, config.opacity);
        let border = config.theme === 'light'
            ? `rgba(0,0,0,${borderOpacity})`
            : `rgba(255,255,255,${borderOpacity})`;
        let width = Math.max(220, config.width);
        let height = Math.max(180, config.height);

        let actor = new St.BoxLayout({
            vertical: true,
            reactive: true,
            track_hover: true,
            style_class: 'spotify-widgets-lyrics-widget',
            style: `
                background-color: ${colors.background};
                border: 1px solid ${border};
                width: ${width}px;
                height: ${height}px;
            `
        });

        actor.set_position(config.x, config.y);

        let state = {
            id: config.id,
            config,
            actor,
            lyricsTitle: null,
            lyricsViewport: null,
            lyricsLabel: null,
            lyricsFooter: null,
            lyricsScrollY: 0,
            resizeButton: null,
            dragging: false,
            dragOffsetX: 0,
            dragOffsetY: 0
        };

        state.lyricsTitle = new St.Label({
            text: this._getLyricsTitle(),
            x_align: Clutter.ActorAlign.CENTER,
            style_class: 'spotify-widgets-lyrics-title'
        });
        state.lyricsTitle.clutter_text.set_line_alignment(
            Clutter.ActorAlign.CENTER
        );
        state.lyricsTitle.clutter_text.set_ellipsize(3);
        state.lyricsTitle.clutter_text.set_single_line_mode(true);
        actor.add_child(state.lyricsTitle);

        state.lyricsViewport = new St.Widget({
            layout_manager: new Clutter.FixedLayout(),
            reactive: true,
            track_hover: true,
            x_expand: true,
            y_expand: true,
            clip_to_allocation: true,
            style: `
                width: ${Math.max(1, width - 32)}px;
                height: ${Math.max(1, height - 32)}px;
            `
        });

        state.lyricsLabel = new St.Label({
            text: this._getLyricsText(),
            style_class: 'spotify-widgets-lyrics-label',
            style: `
                color: ${colors.text};
                font-size: 15px;
                width: ${Math.max(1, width - 32)}px;
            `
        });
        state.lyricsLabel.clutter_text.set_line_wrap(true);
        state.lyricsLabel.set_position(0, 0);

        state.lyricsViewport.add_child(state.lyricsLabel);
        actor.add_child(state.lyricsViewport);

        let footerRow = new St.BoxLayout({
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'spotify-widgets-lyrics-footer-row'
        });

        state.lyricsFooter = new St.Label({
            text: _("Lyrics from LRCLIB"),
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'spotify-widgets-lyrics-footer'
        });

        state.resizeButton = this._createMultiResizeButton(state, colors);

        footerRow.add_child(state.lyricsFooter);
        footerRow.add_child(state.resizeButton);
        actor.add_child(footerRow);

        state.lyricsViewport.connect('scroll-event', (actor, event) => {
            let direction = event.get_scroll_direction();
            let delta = 0;

            if (direction === Clutter.ScrollDirection.DOWN)
                delta = 36;
            else if (direction === Clutter.ScrollDirection.UP)
                delta = -36;
            else if (direction === Clutter.ScrollDirection.SMOOTH) {
                let [, dy] = event.get_scroll_delta();
                delta = dy * 36;
            }

            let maxScroll = Math.max(
                0,
                state.lyricsLabel.get_height() - state.lyricsViewport.get_height()
            );

            state.lyricsScrollY = Math.max(
                0,
                Math.min(maxScroll, state.lyricsScrollY + delta)
            );
            state.lyricsLabel.translation_y = -state.lyricsScrollY;

            return Clutter.EVENT_STOP;
        });

        this._applyLyricsLayout(state);

        actor.connect('button-press-event', (actor, event) => {
            if (event.get_button() !== 1)
                return Clutter.EVENT_PROPAGATE;

            let source = event.get_source?.() || null;

            while (source) {
                if (source._multiDragBlocked)
                    return Clutter.EVENT_PROPAGATE;

                source = source.get_parent?.() || null;
            }

            let [stageX, stageY] = event.get_coords();
            let [x, y] = actor.get_position();

            state.dragging = true;
            state.dragOffsetX = stageX - x;
            state.dragOffsetY = stageY - y;

            return Clutter.EVENT_STOP;
        });

        actor.connect('motion-event', (actor, event) => {
            if (!state.dragging)
                return Clutter.EVENT_PROPAGATE;

            let eventState = event.get_state();

            if (!(eventState & Clutter.ModifierType.BUTTON1_MASK)) {
                state.dragging = false;
                return Clutter.EVENT_PROPAGATE;
            }

            let [stageX, stageY] = event.get_coords();
            actor.set_position(
                stageX - state.dragOffsetX,
                stageY - state.dragOffsetY
            );

            return Clutter.EVENT_STOP;
        });

        actor.connect('button-release-event', () => {
            if (!state.dragging)
                return Clutter.EVENT_PROPAGATE;

            state.dragging = false;
            let [x, y] = actor.get_position();
            this._updateDesktopWidgetConfig(config.id, {
                x: Math.floor(x),
                y: Math.floor(y)
            }, {
                skipRecreate: true
            });

            return Clutter.EVENT_STOP;
        });

        Main.layoutManager.addTopChrome(actor);

        this._fetchLyricsForCurrentTrack();

        return state;
    }

    // Media widgets share one config format; overlay mode is interactive while
    // desktop mode is placed behind regular application windows.
    _createMultiWidget(config) {
        if (config.mode === 'lyrics')
            return this._createLyricsWidget(config);

        if (config.mode === 'equalizer')
            return this._createEqualizerWidget(config);

        let interactive = config.mode === 'overlay';
        let colors = this._getMultiWidgetColors(config);
        let borderOpacity = config.theme === 'light'
            ? Math.min(0.12, config.opacity)
            : Math.min(0.08, config.opacity);
        let border = config.theme === 'light'
            ? `rgba(0,0,0,${borderOpacity})`
            : `rgba(255,255,255,${borderOpacity})`;
        let width = Math.max(180, config.width);
        let height = Math.max(80, config.height);
        let coverSize = config.mode === 'desktop'
            ? Math.max(1, Math.round(150 * config.coverScale))
            : 150;

        let contentBox = null;
            let actor = config.mode === 'overlay'
                ? new St.Widget({
                    layout_manager: new Clutter.FixedLayout(),
                    reactive: interactive,
                    track_hover: interactive,
                    clip_to_allocation: true,
                    style_class: 'spotify-widgets-overlay-widget',
                    style: `
                    background-color: ${colors.background};
                    border: 1px solid ${border};
                    width: ${width}px;
                    height: ${height}px;
                `
            })
            : new St.BoxLayout({
                vertical: true,
                reactive: interactive,
                track_hover: interactive,
                style_class: 'spotify-widgets-desktop-widget',
                style: `
                    background-color: ${colors.background};
                    border: 1px solid ${border};
                    width: ${width}px;
                    height: ${height}px;
                `
            });

        if (config.mode === 'overlay') {
            contentBox = new St.BoxLayout({
                vertical: true,
                style: `
                    padding: 16px;
                    width: ${width}px;
                    spacing: 8px;
                `
            });
            actor.add_child(contentBox);
        }

        let contentTarget = contentBox || actor;

        actor.set_position(config.x, config.y);

        let state = {
            id: config.id,
            config,
            actor,
            contentBox,
            cover: null,
            label: null,
            prevButton: null,
            prevIcon: null,
            playButton: null,
            nextButton: null,
            nextIcon: null,
            titleLabel: null,
            artistLabel: null,
            albumLabel: null,
            progressBar: null,
            progressFill: null,
            timeStart: null,
            timeEnd: null,
            playIcon: null,
            lockIcon: null,
            lockButton: null,
            compactIcon: null,
            compactButton: null,
            header: null,
            controlsRow: null,
            timeBox: null,
            resizeButton: null,
            controlsSpacer: null,
            progressThumb: null,
            progressTooltip: null,
            progressThumbSize: 11,
            locked: false,
            compact: false,
            dragging: false,
            dragOffsetX: 0,
            dragOffsetY: 0
            };

            if (config.mode === 'overlay') {
                state.header = new St.BoxLayout({
                    x_expand: true,
                    x_align: Clutter.ActorAlign.FILL,
                    y_align: Clutter.ActorAlign.CENTER,
                    style_class: 'spotify-widgets-overlay-header'
                });

                let lock = this._createMultiIconButton(
                    "changes-allow-symbolic",
                    colors,
                    30,
                    18,
                    () => {
                        state.locked = !state.locked;
                        state.lockIcon.set_icon_name(
                            state.locked
                                ? "changes-prevent-symbolic"
                                : "changes-allow-symbolic"
                        );
                    }
                );

                let compact = this._createMultiIconButton(
                    "pan-up-symbolic",
                    colors,
                    30,
                    18,
                    () => {}
                );
                compact.button.connect('button-release-event', (actor, event) => {
                    if (event.get_button() !== 1)
                        return Clutter.EVENT_PROPAGATE;

                    actor.remove_all_transitions();
                    actor.set_scale(1, 1);

                    state.compact = !state.compact;
                    state.compactIcon.set_icon_name(
                        state.compact
                            ? "pan-down-symbolic"
                            : "pan-up-symbolic"
                    );
                    this._applyMultiOverlayLayout(state);

                    return Clutter.EVENT_STOP;
                });

            state.lockIcon = lock.icon;
            state.lockButton = lock.button;
            state.compactIcon = compact.icon;
            state.compactButton = compact.button;
            state.header.add_child(lock.button);
            state.header.add_child(new St.Widget({
            x_expand: true
            }));
            state.header.add_child(state.compactButton);
                contentTarget.add_child(state.header);
        }

            if (!config.hideCover) {
                state.cover = new St.Icon({
                icon_size: coverSize,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER
            });

                contentTarget.add_child(state.cover);
        }

        if (config.mode === 'desktop') {
            if (
                !(
                    config.hideTitle &&
                    config.hideArtist &&
                    config.hideAlbum
                )
            ) {
                let textScale = config.textScale || 1;

                state.label = new St.Label({
                    text: this._getMultiWidgetText(config),
                    x_align: Clutter.ActorAlign.CENTER,
                    style_class: 'spotify-widgets-widget-label',
                    style: `
                        color: ${colors.text};
                        font-size: ${Math.round(16 * textScale)}px;
                        max-width: ${Math.max(20, width - 24)}px;
                        margin-top: 12px;
                    `
                });
                state.label.clutter_text.set_line_alignment(
                    Clutter.ActorAlign.CENTER
                );
                state.label.clutter_text.set_ellipsize(3);
                state.label.clutter_text.set_single_line_mode(true);
                    contentTarget.add_child(state.label);
            }
        } else if (
            !(
                config.hideTitle &&
                config.hideArtist &&
                config.hideAlbum
            )
        ) {
                state.label = new St.Label({
                text: this._getMultiWidgetText(config),
                x_align: Clutter.ActorAlign.CENTER,
                style_class: 'spotify-widgets-widget-label',
                style: `
                    color: ${colors.text};
                    font-size: 16px;
                    max-width: ${Math.max(120, width - 32)}px;
                `
            });
            state.label.clutter_text.set_line_alignment(
                Clutter.ActorAlign.CENTER
            );
                state.label.clutter_text.set_ellipsize(3);
                state.label.clutter_text.set_single_line_mode(true);
            contentTarget.add_child(state.label);
        }

            if (config.mode === 'overlay') {
                state.controlsRow = new St.BoxLayout({
                    x_align: Clutter.ActorAlign.FILL,
                    x_expand: true,
                    y_align: Clutter.ActorAlign.CENTER,
                    style_class: 'spotify-widgets-overlay-controls-row'
                });

                let controls = new St.BoxLayout({
                    x_align: Clutter.ActorAlign.CENTER,
                    x_expand: true,
                    style_class: 'spotify-widgets-overlay-controls'
                });

            let prev = this._createMultiIconButton(
                "media-skip-backward-symbolic",
                colors,
                48,
                28,
                () => {
                    if (this.proxy)
                        this.proxy.call('Previous', null, 0, -1, null, null);
                }
            );

            let play = this._createMultiIconButton(
                this._isPlaying
                    ? "media-playback-pause-symbolic"
                    : "media-playback-start-symbolic",
                colors,
                48,
                28,
                () => {
                    if (this.proxy)
                        this.proxy.call('PlayPause', null, 0, -1, null, null);
                }
            );

            let next = this._createMultiIconButton(
                "media-skip-forward-symbolic",
                colors,
                48,
                28,
                () => {
                    if (this.proxy)
                        this.proxy.call('Next', null, 0, -1, null, null);
                }
            );

            state.prevButton = prev.button;
            state.prevIcon = prev.icon;
            state.playButton = play.button;
            state.playIcon = play.icon;
            state.nextButton = next.button;
            state.nextIcon = next.icon;
            state.resizeButton = this._createMultiResizeButton(state, colors);
            controls.add_child(prev.button);
            controls.add_child(play.button);
            controls.add_child(next.button);
            state.controlsSpacer = new St.Widget({
                width: 28,
                height: 28
            });
            state.controlsRow.add_child(state.controlsSpacer);
            state.controlsRow.add_child(controls);
            state.controlsRow.add_child(state.resizeButton);
                contentTarget.add_child(state.controlsRow);
        }

        if (config.mode === 'overlay' || !config.hideProgress) {
            let progressColor = this._getWidgetProgressColor(config);
            let progressHeight = config.mode === 'desktop'
                ? Math.max(1, Math.round(6 * config.timesScale))
                : 6;
            let progressLength = config.mode === 'desktop'
                ? Math.max(1, config.progressWidth)
                : 0;
            let timeFontSize = config.mode === 'desktop'
                ? Math.max(1, Math.round(13 * config.timesScale))
                : 13;
            let timeWidth = config.mode === 'desktop'
                ? Math.max(1, Math.round(34 * config.timesScale))
                : 34;
            state.progressHeight = progressHeight;

            if (progressLength > 0)
                state.progressWidth = progressLength;

            state.timeBox = new St.BoxLayout({
                x_align: Clutter.ActorAlign.FILL,
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'spotify-widgets-overlay-time-box'
            });

            state.timeStart = new St.Label({
                text: "0:00",
                visible: !config.hideTimes,
                width: timeWidth,
                y_align: Clutter.ActorAlign.CENTER,
                style: `font-size: ${timeFontSize}px; color: ${colors.text};`
            });
                state.timeStart.translation_y = config.mode === 'desktop' ? -1 : 1;
                state.timeStart.translation_x = config.mode === 'desktop' ? 6 : 9;

            state.progressBar = new St.Widget({
                layout_manager: new Clutter.FixedLayout(),
                reactive: interactive,
                track_hover: interactive,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'spotify-widgets-progress-bar',
                style: `
                    ${progressLength > 0 ? `width: ${progressLength}px; min-width: ${progressLength}px; max-width: ${progressLength}px;` : ''}
                    height: ${progressHeight}px;
                    background: ${colors.progress};
                `
            });
            state.progressBar._multiDragBlocked = true;

            state.progressFill = new St.BoxLayout({
                x: 0,
                y: 0,
                style_class: 'spotify-widgets-progress-fill',
                style: `
                    height: ${progressHeight}px;
                    width: 0px;
                    background: ${progressColor};
                `
            });

            state.progressBar.add_child(state.progressFill);

            state.progressThumb = new St.Widget({
                visible: false,
                reactive: false,
                width: state.progressThumbSize,
                height: state.progressThumbSize,
                style_class: 'spotify-widgets-progress-thumb',
                style: `
                    width: ${state.progressThumbSize}px;
                    height: ${state.progressThumbSize}px;
                    background: ${colors.text};
                `
            });

            state.progressTooltip = new St.Label({
                visible: false,
                text: "0:00",
                style_class: 'spotify-widgets-progress-tooltip',
                style: `
                    background-color: ${colors.tooltipBg};
                    color: ${colors.tooltipText};
                `
            });

            state.progressBar.add_child(state.progressThumb);
            state.progressBar.add_child(state.progressTooltip);

            state.timeEnd = new St.Label({
                text: "0:00",
                visible: !config.hideTimes,
                width: timeWidth,
                y_align: Clutter.ActorAlign.CENTER,
                style: `font-size: ${timeFontSize}px; color: ${colors.text};`
            });
                state.timeEnd.translation_y = config.mode === 'overlay' ? 1 : -1;

            state.progressBar.connect('enter-event', (actor, event) => {
                if (state.progressThumb)
                    state.progressThumb.visible = true;
                if (state.progressTooltip)
                    state.progressTooltip.visible = true;
                this._updateMultiWidgetProgress();
                this._updateMultiProgressTooltip(event, state);
            });

            state.progressBar.connect('leave-event', () => {
                if (this._multiSeekingState === state)
                    return Clutter.EVENT_PROPAGATE;

                if (state.progressThumb)
                    state.progressThumb.visible = false;
                if (state.progressTooltip)
                    state.progressTooltip.visible = false;

                return Clutter.EVENT_PROPAGATE;
            });

            state.progressBar.connect('motion-event', (actor, event) => {
                if (this._multiSeekingState === state)
                    this._updateMultiSeekDrag(event);
                else
                    this._updateMultiProgressTooltip(event, state);

                return Clutter.EVENT_PROPAGATE;
            });

            state.progressBar.connect('button-press-event', (actor, event) => {
                this._beginMultiSeek(event, state);

                return Clutter.EVENT_STOP;
            });

            state.progressBar.connect('button-release-event', (actor, event) => {
                this._finishMultiSeek(event);

                return Clutter.EVENT_STOP;
            });

            state.timeBox.add_child(state.timeStart);
            state.timeBox.add_child(state.progressBar);
            state.timeBox.add_child(state.timeEnd);
                contentTarget.add_child(state.timeBox);
        }

        if (interactive) {
            actor.connect('button-press-event', (actor, event) => {
                if (event.get_button() !== 1 || state.locked)
                    return Clutter.EVENT_PROPAGATE;

                let source = event.get_source?.() || null;

                while (source) {
                    if (source._multiDragBlocked)
                        return Clutter.EVENT_PROPAGATE;

                    source = source.get_parent?.() || null;
                }

                let [stageX, stageY] = event.get_coords();
                let [x, y] = actor.get_position();

                state.dragging = true;
                state.dragOffsetX = stageX - x;
                state.dragOffsetY = stageY - y;

                return Clutter.EVENT_STOP;
            });

            actor.connect('motion-event', (actor, event) => {
                if (!state.dragging)
                    return Clutter.EVENT_PROPAGATE;

                let eventState = event.get_state();

                if (!(eventState & Clutter.ModifierType.BUTTON1_MASK)) {
                    state.dragging = false;
                    return Clutter.EVENT_PROPAGATE;
                }

                let [stageX, stageY] = event.get_coords();
                actor.set_position(
                    stageX - state.dragOffsetX,
                    stageY - state.dragOffsetY
                );

                return Clutter.EVENT_STOP;
            });

            actor.connect('button-release-event', () => {
                if (!state.dragging)
                    return Clutter.EVENT_PROPAGATE;

                state.dragging = false;
                let [x, y] = actor.get_position();
                this._updateDesktopWidgetConfig(config.id, {
                    x: Math.floor(x),
                    y: Math.floor(y)
                }, {
                    skipRecreate: true
                });

                return Clutter.EVENT_STOP;
            });
        }

        this._applyMultiOverlayLayout(state);

        if (interactive)
            Main.layoutManager.addTopChrome(actor);
        else
            this._addMultiWidgetToBackground(actor);

        return state;
    }

    _updateMultiWidgets() {
        if (!this._multiWidgets)
            return;

        this._multiWidgets.forEach(state => {
            let config = state.config;
            let text = this._getMultiWidgetText(config);

            if (state.label)
                state.label.set_text(text);

            if (state.equalizerLabel)
                state.equalizerLabel.set_text(text);

            if (state.equalizerCenterActor)
                this._updateEqualizerCenter(state);

            if (state.lyricsLabel)
                state.lyricsLabel.set_text(this._getLyricsText());

            if (state.lyricsTitle)
                state.lyricsTitle.set_text(this._getLyricsTitle());

            if (state.playIcon) {
                state.playIcon.set_icon_name(
                    this._isPlaying
                        ? "media-playback-pause-symbolic"
                        : "media-playback-start-symbolic"
                );
            }

            if (state.cover) {
                try {
                    if (this._trackArtUrl) {
                        let file = Gio.File.new_for_uri(this._trackArtUrl);
                        state.cover.set_gicon(new Gio.FileIcon({ file }));
                        state.cover.set_style('');
                    } else {
                        state.cover.set_gicon(this._getSpotifyIconGicon());
                        state.cover.set_style('color: #1DB954;');
                    }
                } catch (e) {
                }
            }
        });

        this._updateMultiWidgetProgress();
    }

    // Estimate position between MPRIS updates so widget progress bars move
    // smoothly without querying DBus on every animation tick.
    _updateMultiWidgetProgress() {
        if (!this._multiWidgets)
            return;

        let position = 0;
        let length = 0;
        let percent = 0;

        try {
            let metadata = this.proxy
                ? this.proxy.get_cached_property('Metadata')
                : null;

            if (metadata) {
                let data = metadata.deep_unpack();
                length = data['mpris:length']?.deep_unpack() || 0;
                position = this._positionStart;

                if (this._isPlaying && !this._seeking) {
                    let now = GLib.get_monotonic_time();
                    position += now - this._positionTimestamp;
                }

                if (length > 0)
                    percent = Math.max(0, Math.min(1, position / length));
            }
        } catch (e) {
        }

        this._multiWidgets.forEach(state => {
            if (!state.progressBar || !state.progressFill)
                return;
            let progressColor = this._getWidgetProgressColor(state.config);

            if (state.timeStart)
                state.timeStart.set_text(this._formatTime(position));

            if (state.timeEnd)
                state.timeEnd.set_text(this._formatTime(length));

            let width = state.progressWidth || state.progressBar.get_width();
            if (width <= 0)
                width = Math.max(40, state.config.width - 92);

            let fillWidth = Math.floor(width * percent);
            let progressHeight = state.progressHeight || 6;

            state.progressFill.set_style(`
                height: ${progressHeight}px;
                width: ${fillWidth}px;
                background: ${progressColor};
            `);
            state.progressFill.set_position(0, 0);
            state.progressFill.set_size(fillWidth, progressHeight);

            if (state.progressThumb) {
                let thumbSize = state.progressThumbSize || 11;

                state.progressThumb.set_position(
                    Math.max(0, fillWidth - thumbSize / 2),
                    (progressHeight - thumbSize) / 2
                );
                state.progressThumb.set_size(thumbSize, thumbSize);
            }
        });
    }

    _setSpotifyVolume(volume) {
        if (!this.proxy)
            return;

        volume = Math.max(0, Math.min(1, volume));

        this.proxy.set_cached_property('Volume', new GLib.Variant('d', volume));
        this.proxy.call(
            'org.freedesktop.DBus.Properties.Set',
            new GLib.Variant('(ssv)', [
                'org.mpris.MediaPlayer2.Player',
                'Volume',
                new GLib.Variant('d', volume)
            ]),
            Gio.DBusCallFlags.NONE,
            -1,
            null,
            null
        );
    }

    _isAdvertisementTrack() {
        let artist = (this._trackArtist || '').trim().toLowerCase();
        let title = (this._trackTitle || '').trim().toLowerCase();
        let advertisementValues = new Set([
            'spotify',
            'spotify premium',
            'advertisement'
        ]);

        return advertisementValues.has(artist) ||
            advertisementValues.has(title);
    }

        _playAdvertisementMuteSound() {
            if (!this.settings.get_boolean("advertisement-mute-sound-enabled"))
                return;

            try {
                let soundPlayer = global.display?.get_sound_player?.();

                if (soundPlayer?.play_from_theme) {
                    soundPlayer.play_from_theme(
                        "message-new-instant",
                        "Spotify advertisement muted",
                        null
                    );
                }
            } catch (e) {
            }
        }

        // Store the user volume before muting and restore it when ad metadata
        // disappears, so the feature does not permanently change Spotify volume.
        _updateAdvertisementMute() {
        if (!this.proxy)
            return;

        let enabled = this.settings.get_boolean('advertisement-mute-enabled');
        let isAdvertisement = enabled && this._isAdvertisementTrack();

        try {
            if (isAdvertisement && !this._advertisementMuteActive) {
                let volumeVar = this.proxy.get_cached_property('Volume');
                this._advertisementPreviousVolume = volumeVar
                    ? volumeVar.deep_unpack()
                    : 1;
                this._advertisementMuteActive = true;
                this._setSpotifyVolume(0);
                this._playAdvertisementMuteSound();

                return;
            }

            if (!isAdvertisement && this._advertisementMuteActive) {
                let volume = typeof this._advertisementPreviousVolume === 'number'
                    ? this._advertisementPreviousVolume
                    : 1;
                this._advertisementMuteActive = false;
                this._advertisementPreviousVolume = null;
                this._setSpotifyVolume(volume);
            }
        } catch (e) {
        }
    }

        _changeVolume(delta) {
        try {
            let volumeVar = this.proxy.get_cached_property('Volume');
            if (!volumeVar)
            return;

            let volume = this._advertisementMuteActive &&
                typeof this._advertisementPreviousVolume === 'number'
                ? this._advertisementPreviousVolume
                : volumeVar.deep_unpack();

            volume += delta;
            volume = Math.max(0, Math.min(1, volume));

            if (this._advertisementMuteActive) {
                this._advertisementPreviousVolume = volume;
                this._setSpotifyVolume(0);
            } else {
                this._setSpotifyVolume(volume);
            }
        let iconName;

        if (volume === 0)
            iconName = 'audio-volume-muted-symbolic';
        else if (volume < 0.33)
            iconName = 'audio-volume-low-symbolic';
        else if (volume < 0.66)
            iconName = 'audio-volume-medium-symbolic';
        else
            iconName = 'audio-volume-high-symbolic';

        this._showVolumeOsd(iconName, volume);

    } catch (e) {
    }
}

// Panel-scroll volume changes use a small extension-owned OSD.
    _showVolumeOsd(iconName, volume) {
    const barWidth = 150;
    let fillWidth = Math.round(barWidth * Math.max(0, Math.min(1, volume)));

        if (!this._volumeOsd) {
            let actor = new St.BoxLayout({
                vertical: true,
                style_class: 'spotify-widgets-volume-osd'
            });

        let row = new St.BoxLayout({
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'spotify-widgets-volume-row'
        });

        let icon = new St.Icon({
            icon_name: iconName,
            icon_size: 28,
            style_class: 'spotify-widgets-volume-icon'
        });

        let bar = new St.Widget({
            layout_manager: new Clutter.FixedLayout(),
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'spotify-widgets-volume-bar'
        });

        let fill = new St.Widget({
            style_class: 'spotify-widgets-volume-fill',
            style: `
                width: ${fillWidth}px;
            `
        });

            let label = new St.Label({
                text: 'Spotify',
                x_align: Clutter.ActorAlign.CENTER,
                style_class: 'spotify-widgets-volume-label'
            });

            bar.add_child(fill);
            row.add_child(icon);
            row.add_child(bar);
            actor.add_child(label);
            actor.add_child(row);
            Main.uiGroup.add_child(actor);

        this._volumeOsd = { actor, icon, fill };
    } else {
        this._volumeOsd.icon.set_icon_name(iconName);
    }

    this._volumeOsd.fill.set_style(`
        width: ${fillWidth}px;
    `);

    let monitor = Main.layoutManager.primaryMonitor;
    let width = this._volumeOsd.actor.get_width() || 230;
    let height = this._volumeOsd.actor.get_height() || 64;

        this._volumeOsd.actor.set_position(
            Math.round(monitor.x + (monitor.width - width) / 2),
            Math.round(monitor.y + monitor.height * 0.92 - height / 2)
        );
        this._volumeOsd.actor.opacity = 255;
        this._volumeOsd.actor.show();
        this._volumeOsd.actor.raise_top();

    this._scheduleVolumeOsdFade(2000);
}

    _scheduleVolumeOsdFade(delay) {
    this._clearVolumeOsdTimeout();

    this._volumeOsdTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
        let sourceId = this._volumeOsdTimeout;

        this._volumeOsdTimeout = null;
        this._sourceIds.delete(sourceId);
        this._fadeVolumeOsd();

        return GLib.SOURCE_REMOVE;
    });
    this._sourceIds.add(this._volumeOsdTimeout);
}

    _clearVolumeOsdTimeout() {
    if (!this._volumeOsdTimeout)
        return;

    try {
        GLib.source_remove(this._volumeOsdTimeout);
    } catch (e) {
    }

    this._sourceIds.delete(this._volumeOsdTimeout);
    this._volumeOsdTimeout = null;
}

    _fadeVolumeOsd() {
    if (!this._volumeOsd?.actor)
        return;

    let actor = this._volumeOsd.actor;

    actor.remove_all_transitions();
    actor.ease({
        opacity: 0,
        duration: 220,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD
    });

    this._addTimeout(GLib.PRIORITY_DEFAULT, 260, () => {
        this._destroyVolumeOsd();
        return GLib.SOURCE_REMOVE;
    });
}

    _destroyVolumeOsd() {
    if (!this._volumeOsd?.actor) {
        this._volumeOsd = null;
        return;
    }

    let actor = this._volumeOsd.actor;

    try {
        let parent = actor.get_parent?.();

        if (parent)
            parent.remove_child(actor);
    } catch (e) {
    }

    try {
        actor.destroy();
    } catch (e) {
    }

    this._volumeOsd = null;
}
// Refresh from the authoritative MPRIS position without allowing normal
// playback resyncs to move the bar backwards.
    _syncPositionNow() {
    if (!this.proxy)
        return;

    this.proxy.call(
        'org.freedesktop.DBus.Properties.Get',
        new GLib.Variant('(ss)', [
            'org.mpris.MediaPlayer2.Player',
            'Position'
        ]),
        Gio.DBusCallFlags.NONE,
        -1,
        null,
        (proxy, res) => {
            try {
                    let result = proxy.call_finish(res);
                    let [variant] = result.deep_unpack();
                    let real = variant.deep_unpack();
                    let now = GLib.get_monotonic_time();
                    let estimated = this._positionStart;

                    if (this._isPlaying)
                        estimated += now - this._positionTimestamp;

                    if (
                        this._isPlaying &&
                        real < estimated
                    )
                        return;
    
                    this._positionStart = real;
                    this._positionTimestamp = now;

            } catch (e) {
            }
        }
    );
}
    _reloadStyle() {
        let margin = this.settings.get_int('margin');

        this.box.set_style(`
            margin-left: ${margin}px;
            margin-right: ${margin}px;
        `);

        
        this.label.clutter_text.set_single_line_mode(true);
        this.label.clutter_text.set_line_wrap(false);

        this.textBox.set_style(`
    overflow: hidden;
`);
        }

// Manual text scrolling lets auto and hover modes share the same animation.
    _startScroll(text) {
    this._stopScroll();

    if (!text || text.length < 10)
        return;

    this.label.clutter_text.set_ellipsize(0);
    this.label.set_text(text);

    let offset = 0;
let speed = 60;
let lastTime = GLib.get_monotonic_time();
    if (this.settings.get_string('scroll-mode') === 'hover') {
        this._scrollState = 'scrolling';
    } else {
        this._scrollState = 'start-delay';
    }

    this._scrollTimeout = this._addTimeout(GLib.PRIORITY_DEFAULT, 16, () => {
        if (!this.label || !this.label.get_parent())
            return GLib.SOURCE_REMOVE;

        let textWidth = this.label.clutter_text.get_layout().get_pixel_size()[0];
        let visibleWidth = this.textBox.get_width();

        if (textWidth <= visibleWidth)
            return GLib.SOURCE_REMOVE;
        if (this._scrollState === 'stopped')
            return true;
        if (this._scrollState === 'start-delay') {
            this._scrollState = 'waiting-start';

            this._addTimeout(GLib.PRIORITY_DEFAULT, 2000, () => {
    lastTime = GLib.get_monotonic_time();
    this._scrollState = 'scrolling';
    return GLib.SOURCE_REMOVE;
});

            return true;
        }

        if (this._scrollState === 'waiting-start')
            return true;
        if (this._scrollState === 'scrolling') {

    let now = GLib.get_monotonic_time();
    let delta = (now - lastTime) / 1000000;
    lastTime = now;

    offset -= speed * delta;

    this.label.translation_x = offset;

            if (Math.abs(offset) >= (textWidth - visibleWidth)) {

                if (this.settings.get_string('scroll-mode') === 'hover') {
                    this._scrollState = 'stopped';
                    return true;
                }
                this._scrollState = 'end-delay';
            }

            return true;
        }
        if (this._scrollState === 'end-delay') {
            this._scrollState = 'waiting-end';

            this._addTimeout(GLib.PRIORITY_DEFAULT, 2000, () => {
    offset = 0;
    this.label.translation_x = 0;

    lastTime = GLib.get_monotonic_time();

    this._scrollState = 'start-delay';
    return GLib.SOURCE_REMOVE;
});

            return true;
        }

        if (this._scrollState === 'waiting-end')
            return true;

        return true;
    });
}

    _stopScroll() {
    if (this._scrollTimeout) {
        this._removeSource(this._scrollTimeout);
        this._scrollTimeout = null;
    }

    this.label.clutter_text.set_ellipsize(3);

    if (this.label)
        this.label.translation_x = 0;
    
}

        // Build the Spotify MPRIS proxy and mirror cached DBus state locally.
        _tryInitProxy() {
            this._disconnectProxySignals();

            let playerProxy = new Gio.DBusProxy({
                g_connection: Gio.DBus.session,
                g_name: "org.mpris.MediaPlayer2.spotify",
                g_object_path: "/org/mpris/MediaPlayer2",
                g_interface_name: "org.mpris.MediaPlayer2.Player"
            });

            this.proxy = playerProxy;

            playerProxy.init_async(GLib.PRIORITY_DEFAULT, null, (proxy, res) => {
                if (this.proxy !== proxy)
                    return;

                try {
                    proxy.init_finish(res);

                    this._seekedSignal = proxy.connectSignal("Seeked", (proxy, sender, [pos]) => {
                        this._positionStart = pos;
                        this._positionTimestamp = GLib.get_monotonic_time();
                    });

                    this._updateMetadata();

                    this._proxySignal = proxy.connect("g-properties-changed", (proxy, changed) => {
                        let changedProps = changed.deep_unpack();

                        if (changedProps.Metadata) {
                            this._updateMetadata();
                            this._positionStart = 0;
                            this._positionTimestamp = GLib.get_monotonic_time();
                        }

                        if (changedProps.PlaybackStatus !== undefined) {
                            let status = proxy.get_cached_property("PlaybackStatus");
                            let playing = status?.deep_unpack() === "Playing";

                            if (playing !== this._isPlaying) {
                                if (!playing) {
                                    let now = GLib.get_monotonic_time();
                                    let delta = now - this._positionTimestamp;
                                    this._positionStart += delta;
                                }

                                this._isPlaying = playing;
                                this._positionTimestamp = GLib.get_monotonic_time();
                                this._syncPositionNow();
                            }

                            if (this._playIcon) {
                                this._playIcon.set_icon_name(
                                    this._isPlaying
                                        ? "media-playback-pause-symbolic"
                                        : "media-playback-start-symbolic"
                                );
                            }

                            this._updateMultiWidgets();
                        }

                        if (changedProps.Position !== undefined) {
                            let pos = proxy.get_cached_property("Position");

                            if (!pos)
                                return;

                            let newPos = pos.deep_unpack();

                            if (newPos < this._positionStart) {
                                this._positionStart = newPos;
                                this._positionTimestamp = GLib.get_monotonic_time();
                                return;
                            }

                            if (Math.abs(newPos - this._positionStart) > 500000) {
                                this._positionStart = newPos;
                                this._positionTimestamp = GLib.get_monotonic_time();
                            }
                        }
                    });
                } catch (e) {
                    if (this.proxy === proxy)
                        this.proxy = null;
                }
            });
        }

        _updateMetadata() {
            if (!this.proxy)
                return;

            let playbackStatus = this.proxy.get_cached_property('PlaybackStatus');
            this._isPlaying = playbackStatus?.deep_unpack() === 'Playing';

            let metadata = this.proxy.get_cached_property('Metadata');
            if (!metadata)
                return;

            let data = metadata.deep_unpack();

            let title = data['xesam:title']?.deep_unpack() || '';
            let artist = data['xesam:artist']?.deep_unpack()?.[0] || '';
            let album = data['xesam:album']?.deep_unpack() || '';
            this._trackTitle = title;
            this._trackArtist = artist;
            this._trackAlbum = album;
            this._trackArtUrl = data['mpris:artUrl']
                ? data['mpris:artUrl'].deep_unpack()
                : null;

            this._updateAdvertisementMute();
            this._fetchLyricsForCurrentTrack(data);

            let showTitle = this.settings.get_boolean('show-title');
            let showArtist = this.settings.get_boolean('show-artist');
            let showAlbum = this.settings.get_boolean('show-album');
            let parts = [];

            if (showArtist)
                parts.push(artist);
            if (showTitle)
                parts.push(title);
            if (showAlbum)
                parts.push(album);

            let text = parts
                .filter(part => part && part.trim() !== "")
                .join(" - ");
            let scrollMode = this.settings.get_string('scroll-mode');

            this._stopScroll();

            if (!text || text.trim() === "")
                text = "Spotify";

            this._fullText = text;
            this.label.set_text(text);
            this.label.queue_relayout();
            this.textBox.queue_relayout();

            this._addIdle(GLib.PRIORITY_DEFAULT, () => {
                if (!this.label)
                    return GLib.SOURCE_REMOVE;

                let textWidth = this.label.clutter_text.get_layout().get_pixel_size()[0];
                let maxWidth = this.settings.get_int('max-width');
                let finalWidth = Math.min(textWidth, maxWidth);

                this.textBox.set_style(`
                    overflow: hidden;
                    width: ${finalWidth}px;
                    max-width: ${maxWidth}px;
                `);

                return GLib.SOURCE_REMOVE;
            });

            if (scrollMode === 'auto')
                this._startScroll(text);

            let iconType = this.settings.get_string('icon-type');

            if (iconType === 'none') {
                this.icon.set_child(null);
            } else if (iconType === 'spotify') {
                this.icon.set_child(new St.Icon({
                    gicon: this._getSpotifyIconGicon(),
                    icon_size: 16,
                    style: 'color: #1DB954;'
                }));
            } else if (iconType === 'album' && data['mpris:artUrl']) {
                let artUrl = data['mpris:artUrl'].deep_unpack();

                try {
                    let file = Gio.File.new_for_uri(artUrl);
                    let icon = new St.Icon({
                        gicon: new Gio.FileIcon({ file }),
                        icon_size: 20
                    });

                    this.icon.set_child(icon);
                } catch (e) {
                }
            }

            if (this._popup && this._popupTitle && this._cover) {
                this._popupTitle.set_text(this._fullText);

                try {
                    if (data['mpris:artUrl']) {
                        let artUrl = data['mpris:artUrl'].deep_unpack();
                        let file = Gio.File.new_for_uri(artUrl);

                        this._cover.set_gicon(new Gio.FileIcon({ file }));
                    }
                } catch (e) {
                }
            }

            if (this._playButton && this._playIcon) {
                this._playIcon.set_icon_name(
                    this._isPlaying
                        ? "media-playback-pause-symbolic"
                        : "media-playback-start-symbolic"
                );
            }

            this._updateMultiWidgets();
        }

    // Rebuild the popup when opened so theme colors and metadata are current.
        _createPopup() {
            this.menu.removeAll();

            if (this._progressTooltip) {
                this._progressTooltip.destroy();
                this._progressTooltip = null;
            }

            this._popup = null;
            this._cover = null;
            this._popupTitle = null;
            this._playButton = null;
            this._playIcon = null;
            this._timeBox = null;
            this._timeStart = null;
            this._timeEnd = null;
            this._progressBar = null;
            this._progressFill = null;
            this._progressTooltip = null;
            this._timeOverlay = null;

            let popupColors = this._getPopupThemeColors();
            this._popup = new St.BoxLayout({
                vertical: true,
                style_class: 'spotify-widgets-popup',
                style: `
                    background-color: ${popupColors.background};
                    border: 1px solid ${popupColors.border};
                `
            });

            let coverGicon = null;

            try {
                let metadata = this.proxy.get_cached_property('Metadata');

                if (metadata) {
                    let data = metadata.deep_unpack();

                    if (data['mpris:artUrl']) {
                        let artUrl = data['mpris:artUrl'].deep_unpack();
                        let file = Gio.File.new_for_uri(artUrl);

                        coverGicon = new Gio.FileIcon({ file });
                    }
                }
            } catch (e) {
            }

            this._cover = new St.Icon({
                gicon: coverGicon,
                icon_size: 140,
                style_class: 'spotify-widgets-popup-cover'
            });
            this._popupTitle = new St.Label({
                text: this._fullText,
                style_class: 'spotify-widgets-popup-title',
                style: `color: ${popupColors.text};`
            });
            this._popupTitle.clutter_text.set_line_alignment(Clutter.ActorAlign.CENTER);

            let controls = new St.BoxLayout({
                x_align: Clutter.ActorAlign.CENTER,
                style_class: 'spotify-widgets-popup-controls'
            });
            let prev = new St.Button({
                child: new St.Icon({
                    icon_name: "media-skip-backward-symbolic",
                    icon_size: 20,
                    style: `color: ${popupColors.text};`
                }),
                style_class: 'spotify-widgets-popup-control-button'
            });
            this._playIcon = new St.Icon({
                icon_name: this._isPlaying
                    ? "media-playback-pause-symbolic"
                    : "media-playback-start-symbolic",
                icon_size: 20,
                style: `color: ${popupColors.text};`
            });
            this._playButton = new St.Button({
                child: this._playIcon,
                style_class: 'spotify-widgets-popup-control-button'
            });
            let next = new St.Button({
                child: new St.Icon({
                    icon_name: "media-skip-forward-symbolic",
                    icon_size: 20,
                    style: `color: ${popupColors.text};`
                }),
                style_class: 'spotify-widgets-popup-control-button'
            });

            const addHover = btn => {
                let bg = new St.Bin({
                    style_class: 'spotify-widgets-popup-hover',
                    style: `background-color: ${popupColors.hover};`,
                    x_align: Clutter.ActorAlign.FILL,
                    y_align: Clutter.ActorAlign.FILL,
                    opacity: 0
                });
                let content = btn.get_child();

                btn.set_child(null);

                let stack = new St.Widget({
                    layout_manager: new Clutter.BinLayout()
                });

                stack.add_child(bg);
                stack.add_child(content);
                btn.set_child(stack);
                bg.set_size(36, 36);
                btn.connect('enter-event', () => {
                    bg.ease({
                        opacity: 255,
                        duration: 150,
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD
                    });
                });
                btn.connect('leave-event', () => {
                    bg.ease({
                        opacity: 0,
                        duration: 150,
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD
                    });
                });
            };

            const addClickAnimation = btn => {
                btn.set_pivot_point(0.5, 0.5);

                const resetScale = () => {
                    btn.ease({
                        scale_x: 1.0,
                        scale_y: 1.0,
                        duration: 170,
                        mode: Clutter.AnimationMode.EASE_OUT_BACK
                    });
                };

                btn.connect('button-press-event', () => {
                    btn.ease({
                        scale_x: 1.2,
                        scale_y: 1.2,
                        duration: 140,
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD
                    });

                    return Clutter.EVENT_PROPAGATE;
                });
                btn.connect('button-release-event', () => {
                    resetScale();
                    return Clutter.EVENT_PROPAGATE;
                });
                btn.connect('clicked', resetScale);
                btn.connect('leave-event', resetScale);
            };

            addClickAnimation(prev);
            addClickAnimation(this._playButton);
            addClickAnimation(next);

            addHover(prev);
            addHover(this._playButton);
            addHover(next);
            prev.connect('clicked', () => {
                this.proxy.call('Previous', null, 0, -1, null, null);
                this._positionStart = 0;
                this._positionTimestamp = GLib.get_monotonic_time();
                this._updateProgressNow();
                this._addTimeout(GLib.PRIORITY_DEFAULT, 150, () => {
                    this._syncPositionNow();
                    this._updateProgressNow();
                    return GLib.SOURCE_REMOVE;
                });
            });
            this._playButton.connect('clicked', () => {
                this.proxy.call('PlayPause', null, 0, -1, null, null);
            });
            next.connect('clicked', () => {
                this.proxy.call('Next', null, 0, -1, null, null);
            });
            controls.add_child(prev);
            controls.add_child(this._playButton);
            controls.add_child(next);
            this._timeBox = new St.BoxLayout({
                style_class: 'spotify-widgets-popup-time-box',
                x_align: Clutter.ActorAlign.FILL
            });
            this._timeOverlay = new St.Widget({
                layout_manager: new Clutter.FixedLayout(),
                x_expand: false,
                y_expand: false,
                style_class: 'spotify-widgets-popup-time-overlay'
            });
            this._timeStart = new St.Label({
                text: "0:00",
                style_class: 'spotify-widgets-popup-time',
                style: `color: ${popupColors.text};`,
                x_expand: false,
                x_align: Clutter.ActorAlign.START,
                translation_x: 4
            });
            this._timeEnd = new St.Label({
                text: "0:00",
                style_class: 'spotify-widgets-popup-time',
                style: `color: ${popupColors.text};`,
                x_expand: false,
                x_align: Clutter.ActorAlign.END
            });

            this._timeStart.clutter_text.set_ellipsize(0);
            this._timeStart.clutter_text.set_single_line_mode(true);
            this._timeEnd.clutter_text.set_ellipsize(0);
            this._timeEnd.clutter_text.set_single_line_mode(true);

            this._progressBar = new St.Widget({
                layout_manager: new Clutter.FixedLayout(),
                reactive: true,
                track_hover: true,
                style_class: 'spotify-widgets-popup-progress-bar',
                style: `background: ${popupColors.progress};`,
                x_expand: true,
                y_expand: false,
                y_align: Clutter.ActorAlign.CENTER
            });
            this._progressThumb = new St.Widget({
                visible: true,
                opacity: 0,
                style_class: 'spotify-widgets-popup-progress-thumb',
                style: `background: ${popupColors.text};`
            });
            this._progressTooltip = new St.Label({
                visible: false,
                text: "0:00",
                style_class: 'spotify-widgets-popup-progress-tooltip',
                style: `
                    background-color: ${popupColors.tooltipBg};
                    color: ${popupColors.tooltipText};
                `
            });
            this._progressFill = new St.BoxLayout({
                x: 0,
                y: 0,
                style_class: 'spotify-widgets-popup-progress-fill',
                style: `
                    width: 0px;
                    background: ${this._getPanelProgressColor()};
                `
            });

            this._progressBar.add_child(this._progressFill);
            this._progressBar.add_child(this._progressThumb);
            this._progressBar.connect('enter-event', () => {
                this._progressThumb.opacity = 255;
                this._progressTooltip.visible = true;
            });
            this._progressBar.connect('leave-event', () => {
                this._progressThumb.opacity = 0;
                this._progressTooltip.visible = false;
            });
            this._progressBar.connect('motion-event', (actor, event) => {
                if (this._seeking)
                    this._updateSeekDrag(event);
                else
                    this._updatePopupProgressTooltip(event);

                return Clutter.EVENT_PROPAGATE;
            });
            this._progressBar.connect('button-press-event', (actor, event) => {
                this._beginSeek(event);

                return Clutter.EVENT_STOP;
            });
            this._progressBar.connect('button-release-event', (actor, event) => {
                this._finishSeek(event);

                return Clutter.EVENT_STOP;
            });

            this._timeBox.add_child(this._timeStart);
            this._timeBox.add_child(this._progressBar);
            this._timeBox.add_child(this._timeEnd);
            this._timeOverlay.add_child(this._timeBox);
            this._timeOverlay.add_child(this._progressTooltip);
            this._timeBox.set_position(0, 0);
            this._timeBox.set_size(260, 18);
            this._popup.add_child(this._cover);
            this._popup.add_child(this._popupTitle);
            this._popup.add_child(controls);
            this._popup.add_child(this._timeOverlay);

            let item = new PopupMenu.PopupBaseMenuItem({
                reactive: true,
                can_focus: false,
                style_class: 'spotify-widgets-popup-menu-item',
            });

            item.add_child(this._popup);
            this.menu.addMenuItem(item);
            this._syncPositionNow();
            this._addTimeout(GLib.PRIORITY_DEFAULT, 10, () => {
                if (!this._popup)
                    return GLib.SOURCE_REMOVE;

                this._updateProgressNow();
                return GLib.SOURCE_REMOVE;
            });
            this._startProgressUpdater();
        }

    _updateProgressNow() {

    if (!this.proxy)
    return;

    let position = 0;
    let length = 0;
    let percent = 0;

    try {
        let metadata = this.proxy.get_cached_property('Metadata');
        if (!metadata)
            return;

        let data = metadata.deep_unpack();

        length = data['mpris:length']?.deep_unpack() || 0;

        if (length <= 0)
            return;

        position = this._positionStart;

        if (this._isPlaying && !this._seeking) {
            let now = GLib.get_monotonic_time();
            let delta = now - this._positionTimestamp;
            position += delta;
        }

        percent = Math.max(0, Math.min(1, position / length));
        if (this._timeStart)
            this._timeStart.set_text(this._formatTime(position));

        if (this._timeEnd)
            this._timeEnd.set_text(this._formatTime(length));
        if (this._progressBar && this._progressFill) {
            let totalWidth = this._progressBar.get_width();

            if (totalWidth <= 0)
                totalWidth = 220;

            let fillWidth = Math.max(0, Math.min(totalWidth, Math.floor(totalWidth * percent)));

            this._progressFill.set_style(`
                width: ${fillWidth}px;
                background: ${this._getPanelProgressColor()};
            `);
            this._progressFill.set_position(0, 0);
            this._progressFill.set_size(fillWidth, 7);

            if (this._progressThumb) {
                this._progressThumb.set_position(
                    Math.max(0, fillWidth - 5),
                    -2
                );
            }
        }

    } catch (e) {
    }
    this._updateMultiWidgetProgress();
    }

    _formatTime(us) {
    let sec = Math.floor(us / 1000000);

    let m = Math.floor(sec / 60);
    let s = sec % 60;

    return `${m}:${s.toString().padStart(2, '0')}`;
}

    _getSeekTarget(event, bar) {

    if (!this.proxy || !bar)
        return null;

    let [x] = event.get_coords();

    let barX = bar.get_transformed_position()[0];

    let width = bar.get_width();

    if (width <= 0)
        return null;

    let percent = (x - barX) / width;

    percent = Math.max(0, Math.min(1, percent));

    let metadata = this.proxy.get_cached_property('Metadata');

    if (!metadata)
        return null;

    let data = metadata.deep_unpack();

    let length = data['mpris:length']?.deep_unpack() || 0;

    if (length <= 0)
        return null;

    let target = Math.floor(length * percent);

    return {
        data,
        target
    };
}

    _previewSeek(target) {

    this._positionStart = target;
    this._positionTimestamp = GLib.get_monotonic_time();

    this._updateProgressNow();
}

    _beginSeek(event) {

    let bar = this._progressBar;

    let seek = this._getSeekTarget(event, bar);

    if (!seek)
        return;

    this._seeking = true;
    this._pendingSeekData = seek.data;
    this._pendingSeekTarget = seek.target;

    this._previewSeek(seek.target);
}

    _updateSeekDrag(event) {

    if (!this._seeking)
        return;

    let bar = this._progressBar;

    let seek = this._getSeekTarget(event, bar);

    if (!seek)
        return;

    this._pendingSeekData = seek.data;
    this._pendingSeekTarget = seek.target;

    this._previewSeek(seek.target);

    this._updatePopupProgressTooltip(event);
}

    _finishSeek(event = null) {

    if (!this._seeking)
        return;

    if (event)
        this._updateSeekDrag(event);

    this._seeking = false;

    if (!this.proxy || !this._pendingSeekData)
        return;

    let target = this._pendingSeekTarget;
    let data = this._pendingSeekData;

    this._pendingSeekData = null;
    this._pendingSeekTarget = null;

    try {

        this.proxy.call(
            'SetPosition',
            new GLib.Variant('(ox)', [
                data['mpris:trackid'].deep_unpack(),
                target
            ]),
            Gio.DBusCallFlags.NONE,
            -1,
            null,
            null
        );

    } catch (e) {
    }
}

    _updatePopupProgressTooltip(event) {

    if (!this.proxy || !this._progressBar || !this._progressTooltip)
        return;

    let metadata = this.proxy.get_cached_property('Metadata');

    if (!metadata)
        return;

    let data = metadata.deep_unpack();
    let length = data['mpris:length']?.deep_unpack() || 0;

    if (length <= 0)
        return;

    let [stageX] = event.get_coords();
    let [barX] = this._progressBar
        .get_transformed_position();
    let [overlayX] = this._timeOverlay
        ? this._timeOverlay.get_transformed_position()
        : [barX];
    let width = this._progressBar.get_width();

    if (width <= 0)
        return;

    let percent = (stageX - barX) / width;

    percent = Math.max(0, Math.min(1, percent));

    let target = Math.floor(length * percent);

    this._progressTooltip.set_text(
        this._formatTime(target)
    );

    let tooltipWidth =
        this._progressTooltip.get_width() || 42;
    let tooltipX =
        Math.max(0, Math.min(width - tooltipWidth, (stageX - barX) - tooltipWidth / 2));

    this._progressTooltip.set_position(
        Math.round(barX - overlayX + tooltipX),
        -20
    );
}

// Run one lightweight updater only while a popup or widget progress bar exists.
    _startProgressUpdater() {
    if (this._progressTimeout)
        this._removeSource(this._progressTimeout);

    this._progressTimeout = this._addTimeout(GLib.PRIORITY_DEFAULT, 250, () => {
    

    if (!this.proxy)
        return true;

    let now = GLib.get_monotonic_time();
    let popupAlive =
    this._popup &&
    this._progressFill &&
    this._progressFill.get_parent();

    let multiWidgetAlive =
        this._multiWidgets &&
        this._multiWidgets.some(state =>
            state.progressFill &&
            state.progressFill.get_parent()
        );
    
    if (!popupAlive && !multiWidgetAlive) {
        this._progressTimeout = null;
        return GLib.SOURCE_REMOVE;
    }

    try {
        let metadata = this.proxy.get_cached_property('Metadata');
        if (!metadata)
            return true;

        let position = this._positionStart;

        if (this._isPlaying && !this._seeking) {
            let delta = now - this._positionTimestamp;
            position += delta;
        }

        let data = metadata.deep_unpack();
        let length = data['mpris:length']?.deep_unpack() || 0;

        if (length === 0)
            return true;

        let percent = position / length;
if (this._timeStart)
    this._timeStart.set_text(this._formatTime(position));

if (this._timeEnd)
    this._timeEnd.set_text(this._formatTime(length));
        percent = Math.max(0, Math.min(1, percent));
    if (this._progressBar && this._progressFill) {
        let totalWidth = this._progressBar.get_width();

if (totalWidth <= 0)
    totalWidth = 220;

let fillWidth = Math.max(0, Math.min(totalWidth, Math.floor(totalWidth * percent)));

        this._progressFill.set_style(`
            width: ${fillWidth}px;
            background: ${this._getPanelProgressColor()};
        `);
this._progressFill.set_position(0, 0);
this._progressFill.set_size(fillWidth, 7);

if (this._progressThumb) {
    this._progressThumb.set_position(
        Math.max(0, fillWidth - 5),
        -2
    );
}
    }

    this._updateMultiWidgetProgress();
    
        } catch (e) {
    }

    return true;
});
}

        // Release actors, DBus hooks, timers, and temporary side effects.
        destroy() {
            if (this._advertisementMuteActive) {
                let volume = typeof this._advertisementPreviousVolume === 'number'
                    ? this._advertisementPreviousVolume
                    : 1;
                this._advertisementMuteActive = false;
                this._advertisementPreviousVolume = null;
                this._setSpotifyVolume(volume);
            }

        this._lyricsRequestSerial++;

        if (this._lyricsSession?.abort)
            this._lyricsSession.abort();

        this._stopScroll();

        this._disconnectProxySignals();

        if (this._spotifyWatchId) {
            Gio.DBus.session.unwatch_name(this._spotifyWatchId);
            this._spotifyWatchId = 0;
        }

            if (this._settingsChangedId)
                this.settings.disconnect(this._settingsChangedId);

            if (this._interfaceChangedId) {
                this._interfaceSettings.disconnect(this._interfaceChangedId);
                this._interfaceChangedId = null;
            }
        if (this._backgroundRestackedId) {
            global.display.disconnect(this._backgroundRestackedId);
            this._backgroundRestackedId = 0;
        }


            if (this._multiStageCaptureId) {
                global.stage.disconnect(this._multiStageCaptureId);
                this._multiStageCaptureId = null;
            }
    
            if (this._popup) {
            this._popup.destroy();
            this._popup = null;
        }

        if (this._progressTooltip) {
            this._progressTooltip.destroy();
            this._progressTooltip = null;
        }

        if (this._volumeOsdTimeout) {
            this._clearVolumeOsdTimeout();
        }

        this._destroyVolumeOsd();

        if (this._progressTimeout) {
            this._removeSource(this._progressTimeout);
            this._progressTimeout = null;
        }
        this._destroyMultiWidgets();
        this._clearSources();

        super.destroy();
    }
});

let indicator = null;

export default class SpotifyExtension extends Extension {
    _reloadPosition() {
        if (indicator) {
            indicator.destroy();
            indicator = null;
        }

        indicator = new SpotifyIndicator(this.settings);

        let position = this.settings.get_string('panel-position');

        let index = 1;
        if (position === 'right') index = 0;
        if (position === 'center') index = 2;

        Main.panel.addToStatusArea('spotify-addon', indicator, index, position);
    }

    enable() {
        this.settings = this.getSettings();

        this._settingsChangedId = this.settings.connect('changed::panel-position', () => {
            this._reloadPosition();
        });

        this._reloadPosition();
    }

    disable() {
        if (indicator) {
            indicator.destroy();
            indicator = null;
        }

        if (this._settingsChangedId) {
            this.settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }
    }
}
