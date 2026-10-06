// AIEditor -> After Effects (ExtendScript). File > Scripts > Run Script File...
var DATA = {
  "comp": {
    "name": "Demo phonk edit",
    "width": 1920,
    "height": 1080,
    "fps": 30,
    "duration": 96.0,
    "background": [0.0, 0.0, 0.0],
    "markers": [{"t": 30.0, "c": "manual 1.00 DROP"}]
  },
  "assets": [
    {
      "id": "ast_3f1c9a0b7d2e4c61",
      "name": "street_run.mp4",
      "path": "D:\\Footage\\street_run.mp4",
      "kind": "video",
      "width": 1920,
      "height": 1080
    },
    {
      "id": "ast_8a7e5d4c3b2a1908",
      "name": "drift_closeup.mov",
      "path": "D:\\Footage\\drift_closeup.mov",
      "kind": "video",
      "width": 3840,
      "height": 2160
    },
    {
      "id": "ast_c0ffee1234abcd56",
      "name": "phonk_track.mp3",
      "path": "D:\\Music\\phonk_track.mp3",
      "kind": "audio",
      "width": null,
      "height": null
    }
  ],
  "layers": [
    {
      "name": "intro slow",
      "asset": "ast_3f1c9a0b7d2e4c61",
      "kind": "video",
      "in": 0.0,
      "out": 15.0,
      "startTime": 0.0,
      "remap": [[0.0, 0.0], [15.0, 7.5]],
      "enabled": true,
      "audio": true,
      "locked": false,
      "blend": "normal",
      "transform": {"anchorX": 0.0, "anchorY": 0.0, "x": 0.0, "y": 0.0, "scale": 1.0, "rotation": 0.0, "opacity": 1.0},
      "levels": 0.0,
      "markers": []
    },
    {
      "name": "street_run.mp4",
      "asset": "ast_3f1c9a0b7d2e4c61",
      "kind": "video",
      "in": 15.0,
      "out": 30.0,
      "startTime": 15.0,
      "remap": [[15.0, 0.0], [30.0, 12.0]],
      "enabled": true,
      "audio": true,
      "locked": false,
      "blend": "normal",
      "transform": {"anchorX": 0.0, "anchorY": 0.0, "x": 0.0, "y": 0.0, "scale": 1.0, "rotation": 0.0, "opacity": 1.0},
      "levels": 0.0,
      "markers": []
    },
    {
      "name": "street_run.mp4",
      "asset": "ast_3f1c9a0b7d2e4c61",
      "kind": "video",
      "in": 30.0,
      "out": 31.875,
      "startTime": 26.0,
      "remap": null,
      "enabled": true,
      "audio": true,
      "locked": false,
      "blend": "normal",
      "transform": {"anchorX": 0.0, "anchorY": 0.0, "x": 0.0, "y": 0.0, "scale": 1.0, "rotation": 0.0, "opacity": 1.0},
      "levels": 0.0,
      "markers": [
        {
          "t": 30.0,
          "c": "fx: zoomPunch (\u0417\u0443\u043c-\u043f\u0430\u043d\u0447) strength=1 amount=1.15 centerX=0 centerY=0 motionBlur=true | env 0.02/0/0.28 easeOut",
          "d": 0.3
        }
      ]
    },
    {
      "name": "street_run.mp4",
      "asset": "ast_3f1c9a0b7d2e4c61",
      "kind": "video",
      "in": 31.875,
      "out": 32.8125,
      "startTime": 31.875,
      "remap": [
        [31.875, 6.6],
        [31.908333, 6.704917],
        [31.941667, 6.805782],
        [31.975, 6.898262],
        [32.008333, 6.978186],
        [32.041667, 7.042439],
        [32.075, 7.08997],
        [32.108333, 7.122204],
        [32.141667, 7.142491],
        [32.175, 7.155075],
        [32.208333, 7.164261],
        [32.241667, 7.173058],
        [32.275, 7.181856],
        [32.308333, 7.190653],
        [32.341667, 7.19945],
        [32.375, 7.208247],
        [32.408333, 7.217045],
        [32.441667, 7.225842],
        [32.475, 7.234639],
        [32.508333, 7.243676],
        [32.541667, 7.255605],
        [32.575, 7.274689],
        [32.608333, 7.305218],
        [32.641667, 7.350711],
        [32.675, 7.412881],
        [32.708333, 7.490982],
        [32.741667, 7.582109],
        [32.775, 7.682166],
        [32.808333, 7.786805],
        [32.8125, 7.8]
      ],
      "enabled": true,
      "audio": true,
      "locked": false,
      "blend": "normal",
      "transform": {"anchorX": 0.0, "anchorY": 0.0, "x": 0.0, "y": 0.0, "scale": 1.0, "rotation": 0.0, "opacity": 1.0},
      "levels": 0.0,
      "markers": []
    },
    {
      "name": "drift_closeup.mov",
      "asset": "ast_8a7e5d4c3b2a1908",
      "kind": "video",
      "in": 32.8125,
      "out": 33.75,
      "startTime": 30.8125,
      "remap": null,
      "enabled": true,
      "audio": true,
      "locked": false,
      "blend": "normal",
      "transform": {
        "anchorX": 0.0,
        "anchorY": 0.0,
        "x": 0.0,
        "y": 0.0,
        "scale": [
          {"t": 32.8125, "v": 1.0, "i": "linear", "o": "bezier", "oS": 0.367816, "oI": 0.1},
          {"t": 33.75, "v": 1.2, "i": "bezier", "o": "linear", "iS": 0.0, "iI": 42.0}
        ],
        "rotation": 0.0,
        "opacity": 1.0
      },
      "levels": null,
      "markers": []
    },
    {
      "name": "FX: FX",
      "adjustment": true,
      "in": 0.0,
      "out": 96.0,
      "enabled": true,
      "locked": false,
      "markers": [
        {
          "t": 0.0,
          "c": "fx: filmGrain (\u041f\u043b\u0451\u043d\u043e\u0447\u043d\u043e\u0435 \u0437\u0435\u0440\u043d\u043e) strength=1 amount=0.12 size=1.5 | env 0/96/0 linear",
          "d": 96.0
        }
      ]
    },
    {
      "name": "FX: FX hits",
      "adjustment": true,
      "in": 0.0,
      "out": 96.0,
      "enabled": true,
      "locked": false,
      "markers": [
        {
          "t": 31.875047,
          "c": "fx: shake (\u0428\u0435\u0439\u043a) strength=1 amount=40 frequency=12 rotation=3 motionBlur=true samples=8 | env 0/0.05/0.3 exp",
          "d": 0.35
        }
      ]
    },
    {
      "name": "phonk_track.mp3",
      "asset": "ast_c0ffee1234abcd56",
      "kind": "audio",
      "in": 0.0,
      "out": 96.0,
      "startTime": 0.0,
      "remap": null,
      "enabled": true,
      "audio": true,
      "locked": false,
      "blend": "normal",
      "transform": null,
      "levels": 0.0,
      "markers": [
        {"t": 0.0, "c": "downbeat 1.00"},
        {"t": 0.0, "c": "section: intro energy=0.35", "d": 15.0},
        {"t": 0.000942, "c": "bass 0.39"},
        {"t": 1.87407, "c": "bass 0.41"},
        {"t": 1.875, "c": "downbeat 1.00"},
        {"t": 3.75, "c": "downbeat 1.00"},
        {"t": 3.75125, "c": "bass 0.42"},
        {"t": 5.625, "c": "downbeat 1.00"},
        {"t": 5.626594, "c": "bass 0.37"},
        {"t": 7.5, "c": "downbeat 1.00"},
        {"t": 7.50266, "c": "bass 0.39"},
        {"t": 9.375, "c": "downbeat 1.00"},
        {"t": 9.376524, "c": "bass 0.42"},
        {"t": 11.25, "c": "downbeat 1.00"},
        {"t": 11.250204, "c": "bass 0.39"},
        {"t": 13.125, "c": "downbeat 1.00"},
        {"t": 13.125958, "c": "bass 0.40"},
        {"t": 15.0, "c": "downbeat 1.00"},
        {"t": 15.0, "c": "section: build energy=0.60", "d": 15.0},
        {"t": 15.003332, "c": "bass 0.65"},
        {"t": 15.939823, "c": "bass 0.41"},
        {"t": 16.872709, "c": "bass 0.67"},
        {"t": 16.875, "c": "downbeat 1.00"},
        {"t": 17.812457, "c": "bass 0.43"},
        {"t": 18.75, "c": "downbeat 1.00"},
        {"t": 18.752017, "c": "bass 0.64"},
        {"t": 19.684034, "c": "bass 0.37"},
        {"t": 20.625, "c": "downbeat 1.00"},
        {"t": 20.628621, "c": "bass 0.65"},
        {"t": 21.565549, "c": "bass 0.45"},
        {"t": 22.498778, "c": "bass 0.58"},
        {"t": 22.5, "c": "downbeat 1.00"},
        {"t": 23.435032, "c": "bass 0.41"},
        {"t": 24.375, "c": "downbeat 1.00"},
        {"t": 24.377741, "c": "bass 0.61"},
        {"t": 25.309773, "c": "bass 0.41"},
        {"t": 26.25, "c": "downbeat 1.00"},
        {"t": 26.25113, "c": "bass 0.60"},
        {"t": 27.185301, "c": "bass 0.39"},
        {"t": 28.125, "c": "downbeat 1.00"},
        {"t": 28.127563, "c": "bass 0.65"},
        {"t": 29.06124, "c": "bass 0.44"},
        {"t": 29.997116, "c": "bass 0.99"},
        {"t": 30.0, "c": "downbeat 1.00"},
        {"t": 30.0, "c": "section: drop energy=0.95", "d": 30.0},
        {"t": 30.469866, "c": "bass 0.58"},
        {"t": 30.939826, "c": "bass 0.59"},
        {"t": 31.40689, "c": "bass 0.58"},
        {"t": 31.875, "c": "downbeat 1.00"},
        {"t": 31.875047, "c": "bass 0.96"},
        {"t": 32.34372, "c": "bass 0.57"},
        {"t": 32.815822, "c": "bass 0.64"},
        {"t": 33.283132, "c": "bass 0.57"},
        {"t": 33.75, "c": "downbeat 1.00"},
        {"t": 33.752015, "c": "bass 0.97"},
        {"t": 34.218438, "c": "bass 0.65"},
        {"t": 34.6837, "c": "bass 0.61"},
        {"t": 35.153609, "c": "bass 0.64"},
        {"t": 35.625, "c": "downbeat 1.00"},
        {"t": 35.627871, "c": "bass 0.92"},
        {"t": 36.09415, "c": "bass 0.66"},
        {"t": 36.565815, "c": "bass 0.58"},
        {"t": 37.029876, "c": "bass 0.62"},
        {"t": 37.49659, "c": "bass 0.99"},
        {"t": 37.5, "c": "downbeat 1.00"},
        {"t": 37.969392, "c": "bass 0.57"},
        {"t": 38.441117, "c": "bass 0.58"},
        {"t": 38.907466, "c": "bass 0.61"},
        {"t": 39.373297, "c": "bass 0.97"},
        {"t": 39.375, "c": "downbeat 1.00"},
        {"t": 39.842145, "c": "bass 0.61"},
        {"t": 40.314549, "c": "bass 0.58"},
        {"t": 40.783345, "c": "bass 0.65"},
        {"t": 41.24739, "c": "bass 0.95"},
        {"t": 41.25, "c": "downbeat 1.00"},
        {"t": 41.715338, "c": "bass 0.59"},
        {"t": 42.189776, "c": "bass 0.59"},
        {"t": 42.652893, "c": "bass 0.59"},
        {"t": 43.125, "c": "downbeat 1.00"},
        {"t": 43.128678, "c": "bass 0.95"},
        {"t": 43.597145, "c": "bass 0.60"},
        {"t": 44.062425, "c": "bass 0.65"},
        {"t": 44.531926, "c": "bass 0.60"},
        {"t": 45.0, "c": "downbeat 1.00"},
        {"t": 45.000308, "c": "bass 0.97"},
        {"t": 45.467936, "c": "bass 0.57"},
        {"t": 45.933827, "c": "bass 0.63"},
        {"t": 46.410186, "c": "bass 0.63"},
        {"t": 46.875, "c": "downbeat 1.00"},
        {"t": 46.878652, "c": "bass 0.91"},
        {"t": 47.345924, "c": "bass 0.65"},
        {"t": 47.810325, "c": "bass 0.63"},
        {"t": 48.283833, "c": "bass 0.61"},
        {"t": 48.747727, "c": "bass 0.98"},
        {"t": 48.75, "c": "downbeat 1.00"},
        {"t": 49.219078, "c": "bass 0.58"},
        {"t": 49.68471, "c": "bass 0.58"},
        {"t": 50.157886, "c": "bass 0.59"},
        {"t": 50.622898, "c": "bass 0.94"},
        {"t": 50.625, "c": "downbeat 1.00"},
        {"t": 51.095596, "c": "bass 0.61"},
        {"t": 51.564344, "c": "bass 0.61"},
        {"t": 52.03391, "c": "bass 0.64"},
        {"t": 52.5, "c": "downbeat 1.00"},
        {"t": 52.501295, "c": "bass 0.91"},
        {"t": 52.969198, "c": "bass 0.60"},
        {"t": 53.435537, "c": "bass 0.60"},
        {"t": 53.906578, "c": "bass 0.63"},
        {"t": 54.373581, "c": "bass 0.99"},
        {"t": 54.375, "c": "downbeat 1.00"},
        {"t": 54.846842, "c": "bass 0.63"},
        {"t": 55.311505, "c": "bass 0.62"},
        {"t": 55.778767, "c": "bass 0.64"},
        {"t": 56.25, "c": "downbeat 1.00"},
        {"t": 56.252354, "c": "bass 0.95"},
        {"t": 56.718373, "c": "bass 0.64"},
        {"t": 57.186605, "c": "bass 0.58"},
        {"t": 57.656792, "c": "bass 0.64"},
        {"t": 58.122486, "c": "bass 0.94"},
        {"t": 58.125, "c": "downbeat 1.00"},
        {"t": 58.59499, "c": "bass 0.62"},
        {"t": 59.063851, "c": "bass 0.62"},
        {"t": 59.530331, "c": "bass 0.61"},
        {"t": 59.996819, "c": "bass 0.38"},
        {"t": 60.0, "c": "downbeat 1.00"},
        {"t": 60.0, "c": "section: break energy=0.30", "d": 15.0},
        {"t": 61.875, "c": "downbeat 1.00"},
        {"t": 61.876882, "c": "bass 0.38"},
        {"t": 63.75, "c": "downbeat 1.00"},
        {"t": 63.750923, "c": "bass 0.34"},
        {"t": 65.62338, "c": "bass 0.36"},
        {"t": 65.625, "c": "downbeat 1.00"},
        {"t": 67.5, "c": "downbeat 1.00"},
        {"t": 67.50209, "c": "bass 0.36"},
        {"t": 69.374497, "c": "bass 0.33"},
        {"t": 69.375, "c": "downbeat 1.00"},
        {"t": 71.25, "c": "downbeat 1.00"},
        {"t": 71.250141, "c": "bass 0.33"},
        {"t": 73.121013, "c": "bass 0.35"},
        {"t": 73.125, "c": "downbeat 1.00"},
        {"t": 74.999819, "c": "bass 0.96"},
        {"t": 75.0, "c": "downbeat 1.00"},
        {"t": 75.0, "c": "section: drop energy=1.00", "d": 15.0},
        {"t": 75.466609, "c": "bass 0.66"},
        {"t": 75.937008, "c": "bass 0.65"},
        {"t": 76.404765, "c": "bass 0.65"},
        {"t": 76.875, "c": "downbeat 1.00"},
        {"t": 76.877689, "c": "bass 1.00"},
        {"t": 77.344843, "c": "bass 0.65"},
        {"t": 77.810708, "c": "bass 0.66"},
        {"t": 78.279715, "c": "bass 0.64"},
        {"t": 78.75, "c": "downbeat 1.00"},
        {"t": 78.750218, "c": "bass 0.99"},
        {"t": 79.222678, "c": "bass 0.66"},
        {"t": 79.689685, "c": "bass 0.69"},
        {"t": 80.157271, "c": "bass 0.69"},
        {"t": 80.623494, "c": "bass 1.00"},
        {"t": 80.625, "c": "downbeat 1.00"},
        {"t": 81.095273, "c": "bass 0.69"},
        {"t": 81.56317, "c": "bass 0.64"},
        {"t": 82.034223, "c": "bass 0.69"},
        {"t": 82.5, "c": "downbeat 1.00"},
        {"t": 82.501438, "c": "bass 1.00"},
        {"t": 82.971474, "c": "bass 0.65"},
        {"t": 83.437633, "c": "bass 0.68"},
        {"t": 83.906555, "c": "bass 0.70"},
        {"t": 84.375, "c": "downbeat 1.00"},
        {"t": 84.378856, "c": "bass 0.98"},
        {"t": 84.847349, "c": "bass 0.60"},
        {"t": 85.310745, "c": "bass 0.63"},
        {"t": 85.778445, "c": "bass 0.69"},
        {"t": 86.25, "c": "downbeat 1.00"},
        {"t": 86.25177, "c": "bass 0.98"},
        {"t": 86.722466, "c": "bass 0.64"},
        {"t": 87.19065, "c": "bass 0.69"},
        {"t": 87.659223, "c": "bass 0.63"},
        {"t": 88.125, "c": "downbeat 1.00"},
        {"t": 88.125967, "c": "bass 1.00"},
        {"t": 88.591209, "c": "bass 0.65"},
        {"t": 89.065311, "c": "bass 0.70"},
        {"t": 89.529496, "c": "bass 0.67"},
        {"t": 89.998295, "c": "bass 0.32"},
        {"t": 90.0, "c": "downbeat 1.00"},
        {"t": 90.0, "c": "section: outro energy=0.25", "d": 6.0},
        {"t": 91.875, "c": "downbeat 1.00"},
        {"t": 91.875379, "c": "bass 0.25"},
        {"t": 93.75, "c": "downbeat 1.00"},
        {"t": 93.752384, "c": "bass 0.28"}
      ]
    }
  ],
  "messages": {
    "missingFile": "\u0424\u0430\u0439\u043b \u043d\u0435 \u043d\u0430\u0439\u0434\u0435\u043d",
    "importFailed": "\u041d\u0435 \u0443\u0434\u0430\u043b\u043e\u0441\u044c \u0438\u043c\u043f\u043e\u0440\u0442\u0438\u0440\u043e\u0432\u0430\u0442\u044c",
    "missingLayer": "\u041d\u0415\u0422 \u0424\u0410\u0419\u041b\u0410",
    "folder": "AIEditor",
    "summary": "AIEditor: \u044d\u043a\u0441\u043f\u043e\u0440\u0442 \u0437\u0430\u0432\u0435\u0440\u0448\u0451\u043d \u0441 \u043f\u0440\u0435\u0434\u0443\u043f\u0440\u0435\u0436\u0434\u0435\u043d\u0438\u044f\u043c\u0438"
  }
};
(function (D) {
  var M = D.messages;
  if (!app.project) app.newProject();
  app.beginUndoGroup("AIEditor: " + D.comp.name);
  var warnings = [];
  var folder = app.project.items.addFolder(D.comp.name + " - " + M.folder);
  var comp = app.project.items.addComp(D.comp.name, D.comp.width, D.comp.height, 1, D.comp.duration, D.comp.fps);
  comp.parentFolder = folder;
  comp.bgColor = D.comp.background;
  var footage = {};
  var assets = {};
  var i;
  for (i = 0; i < D.assets.length; i++) assets[D.assets[i].id] = D.assets[i];

  function importAsset(a) {
    if (footage.hasOwnProperty(a.id)) return footage[a.id];
    var item = null;
    var f = new File(a.path);
    if (f.exists) {
      try {
        item = app.project.importFile(new ImportOptions(f));
        item.parentFolder = folder;
      } catch (e) {
        warnings.push(M.importFailed + ": " + a.path + " (" + e.toString() + ")");
        item = null;
      }
    } else {
      warnings.push(M.missingFile + ": " + a.path);
    }
    footage[a.id] = item;
    return item;
  }

  function interp(name) {
    if (name === "hold") return KeyframeInterpolationType.HOLD;
    if (name === "bezier") return KeyframeInterpolationType.BEZIER;
    return KeyframeInterpolationType.LINEAR;
  }

  function vec(prop, v) {
    var cur = prop.value;
    if (!(cur instanceof Array)) return v;
    var out = [];
    for (var j = 0; j < cur.length; j++) out.push(v);
    return out;
  }

  function eases(prop, speed, influence) {
    var n = prop.isSpatial ? 1 : (prop.value instanceof Array ? prop.value.length : 1);
    var out = [];
    for (var j = 0; j < n; j++) out.push(new KeyframeEase(speed, influence));
    return out;
  }

  function animate(prop, spec, mul, add) {
    if (spec === null || spec === undefined || !prop) return;
    if (typeof spec === "number") {
      prop.setValue(vec(prop, spec * mul + add));
      return;
    }
    var times = [], values = [], j;
    for (j = 0; j < spec.length; j++) {
      times.push(spec[j].t);
      values.push(vec(prop, spec[j].v * mul + add));
    }
    prop.setValuesAtTimes(times, values);
    for (j = 0; j < spec.length; j++) {
      var k = spec[j];
      var idx = prop.nearestKeyIndex(k.t);
      if (k.i === "bezier" || k.o === "bezier") {
        prop.setTemporalEaseAtKey(
          idx,
          eases(prop, k.iS === undefined ? 0 : k.iS * mul, k.iI === undefined ? 16.666667 : k.iI),
          eases(prop, k.oS === undefined ? 0 : k.oS * mul, k.oI === undefined ? 16.666667 : k.oI)
        );
      }
      prop.setInterpolationTypeAtKey(idx, interp(k.i), interp(k.o));
    }
  }

  function addMarkers(prop, list) {
    for (var j = 0; j < list.length; j++) {
      var m = new MarkerValue(list[j].c);
      if (list[j].d) m.duration = list[j].d;
      prop.setValueAtTime(list[j].t, m);
    }
  }

  var BLEND = {
    normal: BlendingMode.NORMAL,
    add: BlendingMode.ADD,
    screen: BlendingMode.SCREEN,
    multiply: BlendingMode.MULTIPLY,
    overlay: BlendingMode.OVERLAY
  };
  var locked = [];

  for (i = 0; i < D.layers.length; i++) {
    var L = D.layers[i];
    var layer;
    if (L.adjustment) {
      layer = comp.layers.addSolid([1, 1, 1], L.name, D.comp.width, D.comp.height, 1, D.comp.duration);
      layer.adjustmentLayer = true;
      layer.startTime = 0;
    } else {
      var asset = assets[L.asset];
      var item = importAsset(asset);
      if (item) {
        layer = comp.layers.add(item);
      } else {
        layer = comp.layers.addSolid([0.3, 0.3, 0.3], M.missingLayer + ": " + asset.name,
          asset.width || D.comp.width, asset.height || D.comp.height, 1, D.comp.duration);
      }
      if (item && L.remap && layer.canSetTimeRemapEnabled) {
        layer.startTime = L["in"];
        layer.timeRemapEnabled = true;
        var tr = layer.property("ADBE Time Remapping");
        while (tr.numKeys > 0) tr.removeKey(1);
        var ts = [], vs = [];
        for (var r = 0; r < L.remap.length; r++) {
          ts.push(L.remap[r][0]);
          vs.push(L.remap[r][1]);
        }
        tr.setValuesAtTimes(ts, vs);
      } else {
        layer.startTime = item ? L.startTime : L["in"];
      }
    }
    layer.name = L.name;
    layer.inPoint = L["in"];
    layer.outPoint = L.out;

    var T = L.transform;
    if (T && layer.property("ADBE Transform Group")) {
      var tg = layer.property("ADBE Transform Group");
      var w = layer.width, h = layer.height;
      var cover = Math.max(D.comp.width / w, D.comp.height / h);
      tg.property("ADBE Anchor Point").setValue([w / 2 + T.anchorX * w / 2, h / 2 + T.anchorY * h / 2]);
      tg.property("ADBE Position").dimensionsSeparated = true;
      animate(tg.property("ADBE Position_0"), T.x, D.comp.width / 2, D.comp.width / 2 + T.anchorX * w * cover / 2);
      animate(tg.property("ADBE Position_1"), T.y, D.comp.height / 2, D.comp.height / 2 + T.anchorY * h * cover / 2);
      animate(tg.property("ADBE Scale"), T.scale, cover * 100, 0);
      animate(tg.property("ADBE Rotate Z"), T.rotation, 1, 0);
      animate(tg.property("ADBE Opacity"), T.opacity, 100, 0);
    }
    if (L.levels !== null && L.levels !== undefined && layer.hasAudio) {
      animate(layer.property("ADBE Audio Group").property("ADBE Audio Levels"), L.levels, 1, 0);
    }
    if (L.audio === false && layer.hasAudio) layer.audioEnabled = false;
    if (L.enabled === false && layer.hasVideo) layer.enabled = false;
    if (L.blend && BLEND[L.blend] !== undefined) layer.blendingMode = BLEND[L.blend];
    addMarkers(layer.property("ADBE Marker"), L.markers);
    if (L.locked) locked.push(layer);
  }

  addMarkers(comp.markerProperty, D.comp.markers);
  for (i = 0; i < locked.length; i++) locked[i].locked = true;
  comp.openInViewer();
  app.endUndoGroup();
  if (warnings.length > 0) alert(M.summary + "\n" + warnings.join("\n"));
})(DATA);
