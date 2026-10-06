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
