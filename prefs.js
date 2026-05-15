import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import GLib from 'gi://GLib';
import {
    ExtensionPreferences,
    gettext as _
} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

// Small row factories keep the preferences UI consistent across pages.
function isButtonUsed(settings, currentKey, button) {
    if (button === 0)
        return false;

    const keys = [
        "playpause-button",
        "next-button",
        "previous-button",
        "popup-button"
    ];

    for (let key of keys) {
        if (key === currentKey)
            continue;

        if (settings.get_int(key) === button)
            return true;
    }

    return false;
}

function createSpinRow(title, key, settings) {
    const row = new Adw.SpinRow({
        title: _(title),
        adjustment: new Gtk.Adjustment({
            lower: 100,
            upper: 600,
            step_increment: 5
        })
    });

    row.set_value(settings.get_int(key));

    row.connect("notify::value", () => {
        settings.set_int(key, row.get_value());
    });

    return row;
}

function createScrollModeRow(settings) {
    const options = [
        { name: _("Disabled"), value: "none" },
        { name: _("Auto scroll"), value: "auto" },
        { name: _("On hover"), value: "hover" }
    ];

    const row = new Adw.ComboRow({ title: _("Text scrolling") });

    const model = new Gtk.StringList();
    options.forEach(o => model.append(o.name));

    row.set_model(model);

    let current = settings.get_string("scroll-mode");
    let index = options.findIndex(o => o.value === current);

    if (index >= 0)
        row.set_selected(index);

    row.connect("notify::selected", () => {
        settings.set_string("scroll-mode", options[row.get_selected()].value);
    });

    return row;
}


function createPositionRow(settings) {
    const row = new Adw.ComboRow({
        title: _("Panel position")
    });

    const options = [
        { name: _("Left"), value: "left" },
        { name: _("Center"), value: "center" },
        { name: _("Right"), value: "right" }
    ];

    const model = new Gtk.StringList();
    options.forEach(o => model.append(o.name));

    row.set_model(model);

    let current = settings.get_string("panel-position");
    let index = options.findIndex(o => o.value === current);

    if (index >= 0)
        row.set_selected(index);

    row.connect("notify::selected", () => {
        let selected = row.get_selected();
        settings.set_string("panel-position", options[selected].value);
    });

    return row;
}

function createDropdownRow(title, key, settings) {
    const row = new Adw.ComboRow({
        title: _(title)
    });

    const options = [
        { name: _("None"), value: 0 },
        { name: _("Left click"), value: 1 },
        { name: _("Middle click"), value: 2 },
        { name: _("Right click"), value: 3 },
        { name: _("Side button 1"), value: 8 },
        { name: _("Side button 2"), value: 9 }
    ];

    const model = new Gtk.StringList();
    options.forEach(o => model.append(o.name));

    row.set_model(model);
    let current = settings.get_int(key);
    let index = options.findIndex(o => o.value === current);

    if (index >= 0)
        row.set_selected(index);

    row.connect("notify::selected", () => {
        let selected = row.get_selected();
        let value = options[selected].value;

        if (isButtonUsed(settings, key, value)) {
            let current = settings.get_int(key);
            let oldIndex = options.findIndex(o => o.value === current);

            if (oldIndex >= 0)
                row.set_selected(oldIndex);

            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                row.set_subtitle(_("Already used!"));
                return GLib.SOURCE_REMOVE;
            });

            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
                row.set_subtitle("");
                return GLib.SOURCE_REMOVE;
            });

            return;
        }

        settings.set_int(key, value);
        row.set_subtitle("");
    });

    return row;
}

function createSliderRow(title, key, settings) {
    const row = new Adw.SpinRow({
        title: _(title),
        adjustment: new Gtk.Adjustment({
            lower: 0,
            upper: 100,
            step_increment: 1
        })
    });

    row.set_value(settings.get_int(key));

    row.connect("notify::value", () => {
        settings.set_int(key, row.get_value());
    });

    return row;
}

function createSwitchRow(title, key, settings) {
    const row = new Adw.SwitchRow({ title: _(title) });

    row.set_active(settings.get_boolean(key));

    row.connect("notify::active", () => {
        settings.set_boolean(key, row.get_active());
    });

    return row;
}

function playAdMutePreviewSound() {
    try {
        GLib.spawn_async(
            null,
            [
                "canberra-gtk-play",
                "-i", "message-new-instant",
                "-d", "Spotify advertisement muted"
            ],
            null,
            GLib.SpawnFlags.SEARCH_PATH,
            null
        );
    } catch (e) {
        Gdk.Display.get_default()?.beep();
    }
}


function createAdMuteSoundSwitchRow(settings) {
    const row = new Adw.SwitchRow({
        title: _("Play alert sound")
    });

    row.set_active(settings.get_boolean("advertisement-mute-sound-enabled"));

    row.connect("notify::active", () => {
        let enabled = row.get_active();

        settings.set_boolean("advertisement-mute-sound-enabled", enabled);

        if (enabled)
            playAdMutePreviewSound();
    });

    return row;
}

function createIconRow(settings) {
    const row = new Adw.ComboRow({
        title: _("Icon")
    });

    const options = [
        { name: _("Album art"), value: "album" },
        { name: _("Spotify icon"), value: "spotify" },
        { name: _("None"), value: "none" }
    ];

    const model = new Gtk.StringList();
    options.forEach(o => model.append(o.name));

    row.set_model(model);

    let current = settings.get_string("icon-type");
    let index = options.findIndex(o => o.value === current);

    if (index >= 0)
        row.set_selected(index);

    row.connect("notify::selected", () => {
        settings.set_string("icon-type", options[row.get_selected()].value);
    });

    return row;
}

function createOpacityRow(title, key, settings) {
    const row = new Adw.SpinRow({
        title: _(title),
        adjustment: new Gtk.Adjustment({
            lower: 0,
            upper: 1.0,
            step_increment: 0.05
        }),
        digits: 2
    });

    row.set_value(settings.get_double(key));

    row.connect("notify::value", () => {
        settings.set_double(key, row.get_value());
    });

    return row;
}

function colorToRgba(color, fallback = "#1DB954") {
    const rgba = new Gdk.RGBA();

    if (!rgba.parse(color || fallback))
        rgba.parse(fallback);

    return rgba;
}

function rgbaToHex(rgba) {
    const component = value =>
        Math.round(Math.max(0, Math.min(1, value)) * 255)
            .toString(16)
            .padStart(2, "0");

    return `#${component(rgba.red)}${component(rgba.green)}${component(rgba.blue)}`;
}

function createColorRow(title, key, settings, fallback = "#1DB954") {
    const row = new Adw.ActionRow({ title: _(title) });
    const button = new Gtk.ColorButton({
        rgba: colorToRgba(settings.get_string(key), fallback),
        valign: Gtk.Align.CENTER
    });

    button.connect("notify::rgba", () => {
        settings.set_string(key, rgbaToHex(button.get_rgba()));
    });

    row.add_suffix(button);
    row.set_activatable_widget(button);

    return row;
}

// Multi-widget state lives as JSON in GSettings because every widget can carry
// its own geometry, visibility flags, theme, and feature-specific options.
function loadDesktopWidgets(settings) {
    try {
        let widgets = JSON.parse(settings.get_string("desktop-widgets"));
        return Array.isArray(widgets) ? widgets : [];
    } catch (e) {
        return [];
    }
}

function saveDesktopWidgets(settings, widgets) {
    settings.set_string("desktop-widgets", JSON.stringify(widgets));
}

function updateDesktopWidget(settings, id, patch) {
    saveDesktopWidgets(settings, loadDesktopWidgets(settings).map(widget =>
        widget.id === id
            ? { ...widget, ...patch }
            : widget
    ));
}

function createWidgetConfig(mode) {
    return {
        id: `${Date.now()}-${Math.floor(Math.random() * 100000)}`,
        enabled: true,
        mode,
        opacity: 0.75,
        theme: "dark",
        x: 100,
        y: 100,
        width: mode === "lyrics"
            ? 360
            : (mode === "equalizer" ? 280 : (mode === "desktop" ? 320 : 332)),
        height: mode === "lyrics"
            ? 420
            : (mode === "equalizer" ? 130 : (mode === "desktop" ? 215 : 320)),
        equalizerType: "bars",
        equalizerCenter: "spotify",
        equalizerStyle: "balanced",
        equalizerColor: "#1DB954",
        progressColor: "#1DB954",
        equalizerSmoothness: "balanced",
        equalizerScale: 1,
        coverScale: 1,
        textScale: 1,
        progressWidth: 220,
        timesScale: 1,
        lyricsFontSize: 15,
        lyricsFontWeight: 400,
        hideCover: false,
        hideTitle: false,
        hideArtist: false,
        hideAlbum: false,
        hideProgress: false,
        hideTimes: false
    };
}

function createWidgetColorRow(title, widget, key, settings, fallback = "#1DB954") {
    const row = new Adw.ActionRow({ title: _(title) });
    const button = new Gtk.ColorButton({
        rgba: colorToRgba(widget[key] ?? fallback, fallback),
        valign: Gtk.Align.CENTER
    });

    button.connect("notify::rgba", () => {
        widget[key] = rgbaToHex(button.get_rgba());
        updateDesktopWidget(settings, widget.id, {
            [key]: widget[key]
        });
    });

    row.add_suffix(button);
    row.set_activatable_widget(button);

    return row;
}

function createWidgetDisableRow(widget, settings) {
    const row = new Adw.SwitchRow({
        title: _("Disable widget")
    });

    row.set_active(widget.enabled === false);

    row.connect("notify::active", () => {
        widget.enabled = !row.get_active();
        updateDesktopWidget(settings, widget.id, {
            enabled: widget.enabled
        });
    });

    return row;
}

function createWidgetOpacityRow(widget, settings) {
    const row = new Adw.SpinRow({
        title: _("Widget opacity"),
        adjustment: new Gtk.Adjustment({
            lower: 0,
            upper: 1.0,
            step_increment: 0.05
        }),
        digits: 2
    });

    row.set_value(widget.opacity ?? 0.75);

    row.connect("notify::value", () => {
        widget.opacity = row.get_value();
        updateDesktopWidget(settings, widget.id, {
            opacity: widget.opacity
        });
    });

    return row;
}

function createWidgetThemeConfigRow(widget, settings) {
    const row = new Adw.ComboRow({
        title: _("Widget theme")
    });

    const options = [
        { name: _("Dark"), value: "dark" },
        { name: _("Light"), value: "light" }
    ];

    const model = new Gtk.StringList();
    options.forEach(o => model.append(o.name));
    row.set_model(model);

    let index = options.findIndex(o => o.value === widget.theme);
    row.set_selected(index >= 0 ? index : 0);

    row.connect("notify::selected", () => {
        widget.theme = options[row.get_selected()].value;
        updateDesktopWidget(settings, widget.id, {
            theme: widget.theme
        });
    });

    return row;
}

function createWidgetIntRow(title, widget, key, settings, lower, upper, step) {
    const row = new Adw.SpinRow({
        title: _(title),
        adjustment: new Gtk.Adjustment({
            lower,
            upper,
            step_increment: step
        })
    });

    row.set_value(widget[key] ?? lower);

    row.connect("notify::value", () => {
        widget[key] = Math.floor(row.get_value());
        updateDesktopWidget(settings, widget.id, {
            [key]: widget[key]
        });
    });

    return row;
}

function createWidgetFontWeightRow(widget, settings) {
    const row = new Adw.ComboRow({
        title: _("Lyrics font weight")
    });

    const options = [
        { name: _("Regular"), value: 400 },
        { name: _("Medium"), value: 500 },
        { name: _("Semi bold"), value: 600 },
        { name: _("Bold"), value: 700 },
        { name: _("Extra bold"), value: 800 }
    ];

    const model = new Gtk.StringList();
    options.forEach(option => model.append(option.name));
    row.set_model(model);

    let current = widget.lyricsFontWeight ?? 400;
    let index = options.findIndex(option => option.value === current);
    row.set_selected(index >= 0 ? index : 0);

    row.connect("notify::selected", () => {
        widget.lyricsFontWeight = options[row.get_selected()].value;
        updateDesktopWidget(settings, widget.id, {
            lyricsFontWeight: widget.lyricsFontWeight
        });
    });

    return row;
}

function createEqualizerStyleRow(widget, settings) {
    const row = new Adw.ComboRow({
        title: _("Equalizer style")
    });

    const options = [
        { name: _("Calm"), value: "calm" },
        { name: _("Balanced"), value: "balanced" },
        { name: _("Pop"), value: "pop" },
        { name: _("Rock"), value: "rock" },
        { name: _("Metal"), value: "metal" }
    ];

    const model = new Gtk.StringList();
    options.forEach(option => model.append(option.name));
    row.set_model(model);

    let current = widget.equalizerStyle ?? "balanced";
    let index = options.findIndex(option => option.value === current);
    row.set_selected(index >= 0 ? index : 1);

    row.connect("notify::selected", () => {
        widget.equalizerStyle = options[row.get_selected()].value;
        updateDesktopWidget(settings, widget.id, {
            equalizerStyle: widget.equalizerStyle
        });
    });

    return row;
}

function createEqualizerTypeRow(widget, settings) {
    const row = new Adw.ComboRow({
        title: _("Equalizer type")
    });

    const options = [
        { name: _("Bars"), value: "bars" },
        { name: _("Circle"), value: "circle" }
    ];

    const model = new Gtk.StringList();
    options.forEach(option => model.append(option.name));
    row.set_model(model);

    let current = widget.equalizerType ?? "bars";
    let index = options.findIndex(option => option.value === current);
    row.set_selected(index >= 0 ? index : 0);

    row.connect("notify::selected", () => {
        widget.equalizerType = options[row.get_selected()].value;
        updateDesktopWidget(settings, widget.id, {
            equalizerType: widget.equalizerType
        });
    });

    return row;
}

function createEqualizerCenterRow(widget, settings) {
    const row = new Adw.ComboRow({
        title: _("Circle center"),
        subtitle: _("Used when Equalizer type is Circle.")
    });

    const options = [
        { name: _("Spotify logo"), value: "spotify" },
        { name: _("Album art"), value: "album" }
    ];

    const model = new Gtk.StringList();
    options.forEach(option => model.append(option.name));
    row.set_model(model);

    let current = widget.equalizerCenter ?? "spotify";
    let index = options.findIndex(option => option.value === current);
    row.set_selected(index >= 0 ? index : 0);

    row.connect("notify::selected", () => {
        widget.equalizerCenter = options[row.get_selected()].value;
        updateDesktopWidget(settings, widget.id, {
            equalizerCenter: widget.equalizerCenter
        });
    });

    return row;
}

function createEqualizerSmoothnessRow(widget, settings) {
    const row = new Adw.ComboRow({
        title: _("Equalizer smoothness"),
        subtitle: _("Higher smoothness can increase CPU usage.")
    });

    const options = [
        { name: _("Low"), value: "low" },
        { name: _("Balanced"), value: "balanced" },
        { name: _("Smooth"), value: "smooth" },
        { name: _("Very smooth"), value: "very-smooth" }
    ];

    const model = new Gtk.StringList();
    options.forEach(option => model.append(option.name));
    row.set_model(model);

    let current = widget.equalizerSmoothness ?? "balanced";
    let index = options.findIndex(option => option.value === current);
    row.set_selected(index >= 0 ? index : 1);

    row.connect("notify::selected", () => {
        widget.equalizerSmoothness = options[row.get_selected()].value;
        updateDesktopWidget(settings, widget.id, {
            equalizerSmoothness: widget.equalizerSmoothness
        });
    });

    return row;
}

function createWidgetDoubleRow(title, widget, key, settings, lower, upper, step, fallback) {
    const row = new Adw.SpinRow({
        title: _(title),
        adjustment: new Gtk.Adjustment({
            lower,
            upper,
            step_increment: step
        }),
        digits: 2
    });

    row.set_value(widget[key] ?? fallback);

    row.connect("notify::value", () => {
        widget[key] = row.get_value();
        updateDesktopWidget(settings, widget.id, {
            [key]: widget[key]
        });
    });

    return row;
}

function createWidgetHideRow(title, widget, key, settings) {
    const row = new Adw.SwitchRow({ title: _(title) });

    row.set_active(!!widget[key]);

    row.connect("notify::active", () => {
        widget[key] = row.get_active();
        updateDesktopWidget(settings, widget.id, {
            [key]: widget[key]
        });
    });

    return row;
}

export default class SpotifyPrefs extends ExtensionPreferences {
    // Assemble the panel, desktop-widget, and advertisement-mute pages.
    fillPreferencesWindow(window) {
        this.settings = this.getSettings();
        window.set_default_size(720, 800);

        const panelPage = new Adw.PreferencesPage();
        const controlsGroup = new Adw.PreferencesGroup({
            title: _("Controls"),
            description: _("Mouse buttons and popup settings")
        });

        controlsGroup.add(createDropdownRow(
            "Play/Pause button",
            "playpause-button",
            this.settings
        ));
        controlsGroup.add(createDropdownRow(
            "Next track button",
            "next-button",
            this.settings
        ));
        controlsGroup.add(createDropdownRow(
            "Previous track button",
            "previous-button",
            this.settings
        ));
        controlsGroup.add(createDropdownRow(
            "Popup button",
            "popup-button",
            this.settings
        ));
        panelPage.add(controlsGroup);

        const appearanceGroup = new Adw.PreferencesGroup({
            title: _("Appearance"),
            description: _("Panel widget appearance")
        });

        appearanceGroup.add(createPositionRow(this.settings));
        appearanceGroup.add(createSliderRow("Margin", "margin", this.settings));
        appearanceGroup.add(createSpinRow("Max text width", "max-width", this.settings));
        appearanceGroup.add(createColorRow(
            "Progress bar color",
            "panel-progress-color",
            this.settings
        ));
        panelPage.add(appearanceGroup);

        const contentGroup = new Adw.PreferencesGroup({
            title: _("Panel content"),
            description: _("Choose what appears on the panel")
        });

        contentGroup.add(createIconRow(this.settings));
        contentGroup.add(createSwitchRow("Show title", "show-title", this.settings));
        contentGroup.add(createSwitchRow("Show artist", "show-artist", this.settings));
        contentGroup.add(createSwitchRow("Show album", "show-album", this.settings));
        contentGroup.add(createScrollModeRow(this.settings));
        panelPage.add(contentGroup);

        const popupGroup = new Adw.PreferencesGroup({
            title: _("Popup"),
            description: _("Popup appearance and behavior")
        });

        popupGroup.add(createSwitchRow(
            "Hide when Spotify is closed",
            "hide-when-stopped",
            this.settings
        ));
        popupGroup.add(createOpacityRow(
            "Popup transparency",
            "popup-bg-opacity",
            this.settings
        ));
        panelPage.add(popupGroup);

        const widgetPage = new Adw.PreferencesPage();
        const addWidgetGroup = new Adw.PreferencesGroup({
            title: _("Desktop widgets")
        });
        const widgetModes = [
            { name: _("Overlay"), value: "overlay" },
            { name: _("Desktop"), value: "desktop" },
            { name: _("Lyrics"), value: "lyrics" },
            { name: _("Equalizer"), value: "equalizer" }
        ];
        const newWidgetModeRow = new Adw.ComboRow({
            title: _("New widget type")
        });

        const newWidgetModeModel = new Gtk.StringList();
        widgetModes.forEach(mode => newWidgetModeModel.append(mode.name));
        newWidgetModeRow.set_model(newWidgetModeModel);
        newWidgetModeRow.set_selected(0);
        addWidgetGroup.add(newWidgetModeRow);

        const addWidgetRow = new Adw.ActionRow({
            title: _("Add widget"),
            subtitle: _("Create a new desktop widget")
        });
        const addWidgetButton = new Gtk.Button({
            label: _("Add"),
            valign: Gtk.Align.CENTER
        });
        addWidgetButton.add_css_class("suggested-action");
        addWidgetRow.add_suffix(addWidgetButton);
        addWidgetRow.set_activatable_widget(addWidgetButton);
        addWidgetGroup.add(addWidgetRow);

        widgetPage.add(addWidgetGroup);

        const widgetsListGroup = new Adw.PreferencesGroup({
            title: _("Widgets")
        });

        widgetPage.add(widgetsListGroup);

        let renderedWidgetRows = [];

        const renderWidgets = () => {
            renderedWidgetRows.forEach(row => {
                widgetsListGroup.remove(row);
            });
            renderedWidgetRows = [];

            let widgets = loadDesktopWidgets(this.settings);

            widgets.forEach((widget, index) => {
                let modeName = widget.mode === "desktop"
                    ? _("Desktop")
                    : (widget.mode === "lyrics"
                        ? _("Lyrics")
                        : (widget.mode === "equalizer" ? _("Equalizer") : _("Overlay")));
                let title = `${_("Widget")} ${index + 1} - ${modeName}`;

                const expander = new Adw.ExpanderRow({
                    title,
                    subtitle: widget.mode === "desktop"
                        ? _("Non-interactive desktop widget")
                        : (widget.mode === "lyrics"
                            ? _("Scrollable lyrics widget")
                            : (widget.mode === "equalizer"
                                ? _("Fake animated equalizer")
                                : _("Interactive overlay widget")))
                });

                expander.add_row(createWidgetDisableRow(widget, this.settings));
                if (widget.mode !== "equalizer")
                    expander.add_row(createWidgetOpacityRow(widget, this.settings));

                if (widget.mode === "lyrics") {
                    expander.add_row(createWidgetThemeConfigRow(widget, this.settings));
                    expander.add_row(createWidgetIntRow(
                        "Lyrics font size",
                        widget,
                        "lyricsFontSize",
                        this.settings,
                        8,
                        48,
                        1
                    ));
                    expander.add_row(createWidgetFontWeightRow(widget, this.settings));
                } else if (widget.mode === "equalizer") {
                    expander.add_row(createEqualizerTypeRow(widget, this.settings));
                    expander.add_row(createEqualizerCenterRow(widget, this.settings));
                    expander.add_row(createWidgetThemeConfigRow(widget, this.settings));
                    expander.add_row(createWidgetColorRow(
                        "Equalizer color",
                        widget,
                        "equalizerColor",
                        this.settings
                    ));
                    expander.add_row(createEqualizerStyleRow(widget, this.settings));
                    expander.add_row(createEqualizerSmoothnessRow(widget, this.settings));
                    expander.add_row(createWidgetOpacityRow(widget, this.settings));
                    expander.add_row(createWidgetIntRow(
                        "Position X",
                        widget,
                        "x",
                        this.settings,
                        -5000,
                        5000,
                        1
                    ));
                    expander.add_row(createWidgetIntRow(
                        "Position Y",
                        widget,
                        "y",
                        this.settings,
                        -5000,
                        5000,
                        1
                    ));
                    expander.add_row(createWidgetDoubleRow(
                        "Equalizer scale",
                        widget,
                        "equalizerScale",
                        this.settings,
                        0.1,
                        5,
                        0.05,
                        1
                    ));
                    expander.add_row(createWidgetHideRow(
                        "Hide title",
                        widget,
                        "hideTitle",
                        this.settings
                    ));
                    expander.add_row(createWidgetHideRow(
                        "Hide artist",
                        widget,
                        "hideArtist",
                        this.settings
                    ));
                    expander.add_row(createWidgetHideRow(
                        "Hide album name",
                        widget,
                        "hideAlbum",
                        this.settings
                    ));
                } else {
                    expander.add_row(createWidgetThemeConfigRow(widget, this.settings));
                }

                if (widget.mode === "overlay") {
                    expander.add_row(createWidgetColorRow(
                        "Progress bar color",
                        widget,
                        "progressColor",
                        this.settings
                    ));
                    expander.add_row(createWidgetHideRow(
                        "Hide title",
                        widget,
                        "hideTitle",
                        this.settings
                    ));
                    expander.add_row(createWidgetHideRow(
                        "Hide artist",
                        widget,
                        "hideArtist",
                        this.settings
                    ));
                    expander.add_row(createWidgetHideRow(
                        "Hide album name",
                        widget,
                        "hideAlbum",
                        this.settings
                    ));
                }

                if (widget.mode === "desktop") {
                    expander.add_row(createWidgetColorRow(
                        "Progress bar color",
                        widget,
                        "progressColor",
                        this.settings
                    ));

                    expander.add_row(createWidgetIntRow(
                        "Position X",
                        widget,
                        "x",
                        this.settings,
                        -5000,
                        5000,
                        1
                    ));
                    expander.add_row(createWidgetIntRow(
                        "Position Y",
                        widget,
                        "y",
                        this.settings,
                        -5000,
                        5000,
                        1
                    ));
                    expander.add_row(createWidgetIntRow(
                        "Widget width",
                        widget,
                        "width",
                        this.settings,
                        100,
                        1200,
                        5
                    ));
                    expander.add_row(createWidgetIntRow(
                        "Widget height",
                        widget,
                        "height",
                        this.settings,
                        60,
                        900,
                        5
                    ));
                    expander.add_row(createWidgetHideRow(
                        "Hide album art",
                        widget,
                        "hideCover",
                        this.settings
                    ));
                    expander.add_row(createWidgetDoubleRow(
                        "Album art scale",
                        widget,
                        "coverScale",
                        this.settings,
                        0.05,
                        5,
                        0.05,
                        1
                    ));
                    expander.add_row(createWidgetHideRow(
                        "Hide title",
                        widget,
                        "hideTitle",
                        this.settings
                    ));
                    expander.add_row(createWidgetHideRow(
                        "Hide artist",
                        widget,
                        "hideArtist",
                        this.settings
                    ));
                    expander.add_row(createWidgetHideRow(
                        "Hide album name",
                        widget,
                        "hideAlbum",
                        this.settings
                    ));
                    expander.add_row(createWidgetDoubleRow(
                        "Text scale",
                        widget,
                        "textScale",
                        this.settings,
                        0.05,
                        5,
                        0.05,
                        1
                    ));
                    expander.add_row(createWidgetHideRow(
                        "Hide progress bar",
                        widget,
                        "hideProgress",
                        this.settings
                    ));
                    expander.add_row(createWidgetDoubleRow(
                        "Progress bar scale",
                        widget,
                        "timesScale",
                        this.settings,
                        0.05,
                        5,
                        0.05,
                        1
                    ));
                    expander.add_row(createWidgetIntRow(
                        "Progress bar length",
                        widget,
                        "progressWidth",
                        this.settings,
                        1,
                        2000,
                        5
                    ));
                    expander.add_row(createWidgetHideRow(
                        "Hide progress times",
                        widget,
                        "hideTimes",
                        this.settings
                    ));
                }

                const removeRow = new Adw.ActionRow({
                    title: _("Remove widget")
                });
                const removeButton = new Gtk.Button({
                    label: _("Remove"),
                    valign: Gtk.Align.CENTER
                });

                removeButton.add_css_class("destructive-action");
                removeRow.add_suffix(removeButton);
                removeRow.set_activatable_widget(removeButton);
                removeButton.connect("clicked", () => {
                    saveDesktopWidgets(
                        this.settings,
                        loadDesktopWidgets(this.settings)
                            .filter(w => w.id !== widget.id)
                    );
                    renderWidgets();
                });
                expander.add_row(removeRow);

                if (widget.mode === "lyrics") {
                    expander.add_row(new Adw.ActionRow({
                        title: _("Lyrics source"),
                        subtitle: _("Lyrics are requested from LRCLIB only for enabled lyrics widgets and only when the current track changes. Artist, title, album, and duration may be sent.")
                    }));
                }

                widgetsListGroup.add(expander);
                renderedWidgetRows.push(expander);
            });
        };

        addWidgetButton.connect("clicked", () => {
            let mode = widgetModes[newWidgetModeRow.get_selected()].value;
            let widgets = loadDesktopWidgets(this.settings);

            widgets.push(createWidgetConfig(mode));
            saveDesktopWidgets(this.settings, widgets);
            renderWidgets();
        });

        renderWidgets();

        const adMutePage = new Adw.PreferencesPage();
        const adMuteGroup = new Adw.PreferencesGroup({
            title: _("Ad mute"),
            description: _("Automatically mute Spotify when an advertisement is detected")
        });

        adMuteGroup.add(createSwitchRow(
            "Enable ad mute",
            "advertisement-mute-enabled",
            this.settings
        ));
        adMuteGroup.add(createAdMuteSoundSwitchRow(this.settings));
        adMuteGroup.add(new Adw.ActionRow({
            title: _("How it works"),
            subtitle: _("When the extension detects an advertisement, it mutes Spotify and restores the previous volume after the ad ends.")
        }));
        adMutePage.add(adMuteGroup);

        panelPage.set_title(_("Panel"));
        widgetPage.set_title(_("Desktop widgets"));
        adMutePage.set_title(_("Ad mute"));
        panelPage.set_icon_name("audio-x-generic-symbolic");
        widgetPage.set_icon_name("view-grid-symbolic");
        adMutePage.set_icon_name("audio-volume-muted-symbolic");
        window.set_search_enabled(true);
        window.set_default_size(720, 800);
        window.add(panelPage);
        window.add(widgetPage);
        window.add(adMutePage);
    }
}
