/**
 * Copyright 2012 Google, Inc. All Rights Reserved.
 *
 * Use of this source code is governed by a BSD-style license that can be
 * found in the LICENSE file.
 */

/**
 * @fileoverview 'Tracks' panel.
 *
 * @author benvanik@google.com (Ben Vanik)
 */

goog.provide('wtf.app.ui.tracks.TracksPanel');

goog.require('goog.array');
goog.require('goog.dom');
goog.require('goog.math.Rect');
goog.require('goog.soy');
goog.require('goog.style');
goog.require('wtf.analysis.db.EventDatabase');
goog.require('wtf.analysis.db.Granularity');
goog.require('wtf.app.ui.FramePainter');
goog.require('wtf.app.ui.MarkPainter');
goog.require('wtf.app.ui.SelectionPainter');
goog.require('wtf.app.ui.TabPanel');
goog.require('wtf.app.ui.tracks.TimeRangePainter');
goog.require('wtf.app.ui.tracks.TrackInfoBar');
goog.require('wtf.app.ui.tracks.ZonePainter');
goog.require('wtf.app.ui.tracks.trackspanel');
goog.require('wtf.events');
goog.require('wtf.events.EventType');
goog.require('wtf.events.KeyboardScope');
goog.require('wtf.timing');
goog.require('wtf.ui.GridPainter');
goog.require('wtf.ui.LayoutMode');
goog.require('wtf.ui.Painter');
goog.require('wtf.ui.ResizableControl');
goog.require('wtf.ui.RulerPainter');
goog.require('wtf.ui.Tooltip');
goog.require('wtf.ui.zoom.TransitionMode');
goog.require('wtf.ui.zoom.Viewport');



/**
 * Tracks panel, showing a list of tracks on a time graph.
 * @param {!wtf.app.ui.DocumentView} documentView Parent document view.
 * @constructor
 * @extends {wtf.app.ui.TabPanel}
 */
wtf.app.ui.tracks.TracksPanel = function(documentView) {
  goog.base(this, documentView, 'tracks', 'Tracks');
  var dom = this.getDom();

  var doc = documentView.getDocument();
  var db = doc.getDatabase();

  /**
   * Database.
   * @type {!wtf.analysis.db.EventDatabase}
   * @private
   */
  this.db_ = db;

  /**
   * Infobar control.
   * @type {!wtf.app.ui.tracks.TrackInfoBar}
   * @private
   */
  this.infobar_ = new wtf.app.ui.tracks.TrackInfoBar(this,
      this.getChildElement(goog.getCssName('infoControl')));
  this.registerDisposable(this.infobar_);
  this.infobar_.addListener(
      wtf.ui.ResizableControl.EventType.SIZE_CHANGED,
      this.layout, this);

  /**
   * Zooming viewport.
   * @type {!wtf.ui.zoom.Viewport}
   * @private
   */
  this.viewport_ = new wtf.ui.zoom.Viewport();
  this.registerDisposable(this.viewport_);
  this.viewport_.setAllowedScales(
      1000 / wtf.app.ui.tracks.TracksPanel.MIN_GRANULARITY_,
      1000 / wtf.app.ui.tracks.TracksPanel.MAX_GRANULARITY_);
  var reentry = 0;
  this.viewport_.addListener(
      wtf.events.EventType.INVALIDATED,
      function() {
        if (reentry) {
          return;
        }
        reentry++;

        var firstEventTime = db.getFirstEventTime();

        // Update from viewport.
        var width = this.viewport_.getScreenWidth();
        var timeLeft = this.viewport_.screenToScene(0, 0).x;
        var timeRight = this.viewport_.screenToScene(width, 0).x;
        timeLeft += firstEventTime;
        timeRight += firstEventTime;

        // Update the main view.
        // This will be ignored if our invalidation came from the view.
        var localView = documentView.getLocalView();
        localView.setVisibleRange(timeLeft, timeRight);

        // Reset painter time ranges.
        for (var n = 0; n < this.timePainters_.length; n++) {
          var painter = this.timePainters_[n];
          painter.setTimeRange(timeLeft, timeRight);
        }

        // Update the tooltip, if it's visible.
        this.updateTooltip();

        this.requestRepaint();
        reentry--;
      }, this);
  // TODO(benvanik): set to something larger to get more precision.
  this.viewport_.setSceneSize(1, 1);

  // Watch for view changes and update.
  var localView = documentView.getLocalView();
  localView.addListener(wtf.events.EventType.INVALIDATED, function(immediate) {
    if (reentry) {
      return;
    }

    var firstEventTime = db.getFirstEventTime();
    var startTime = localView.getVisibleTimeStart() - firstEventTime;
    var endTime = localView.getVisibleTimeEnd() - firstEventTime - startTime;
    this.viewport_.zoomToBounds(
        startTime, 0, endTime, 0.001,
        immediate ? wtf.ui.zoom.TransitionMode.IMMEDIATE : undefined);
  }, this);

  // Setup keyboard hooks. These are only valid when the panel is active.
  var keyboard = wtf.events.getWindowKeyboard(dom);
  /**
   * Keyboard scope.
   * @type {!wtf.events.KeyboardScope}
   * @private
   */
  this.keyboardScope_ = new wtf.events.KeyboardScope(keyboard);
  this.registerDisposable(this.keyboardScope_);
  this.setupKeyboardShortcuts_();

  /**
   * Track canvas.
   * @type {!HTMLCanvasElement}
   * @private
   */
  this.trackCanvas_ = /** @type {!HTMLCanvasElement} */ (
      this.getChildElement(goog.getCssName('canvas')));

  var tooltip = new wtf.ui.Tooltip(this.getDom());
  this.registerDisposable(tooltip);
  this.setTooltip(tooltip);

  var paintContext = new wtf.ui.Painter(this.trackCanvas_);
  this.setPaintContext(paintContext);

  // Clicking on non-handled space will clear the filter.
  var commandManager = wtf.events.getCommandManager();
  paintContext.onClickInternal = goog.bind(function(x, y, modifiers, bounds) {
    commandManager.execute('filter_events', this, null, '');
  }, this);

  /**
   * A list of all paint contexts that extend {@see wtf.ui.TimePainter}.
   * This is used to update all of the painters when the current time range
   * changes.
   * @type {!Array.<!wtf.ui.TimePainter>}
   * @private
   */
  this.timePainters_ = [];

  var gridPainter = new wtf.ui.GridPainter(this.trackCanvas_);
  paintContext.addChildPainter(gridPainter);
  gridPainter.setGranularities(
      wtf.app.ui.tracks.TracksPanel.MIN_GRANULARITY_,
      wtf.app.ui.tracks.TracksPanel.MAX_GRANULARITY_);
  this.timePainters_.push(gridPainter);

  /**
   * Selection painter.
   * @type {!wtf.app.ui.SelectionPainter}
   * @private
   */
  this.selectionPainter_ = new wtf.app.ui.SelectionPainter(
      this.trackCanvas_, documentView.getSelection(), this.viewport_);
  paintContext.addChildPainter(this.selectionPainter_);
  this.timePainters_.push(this.selectionPainter_);

  /**
   * Vertical stack of painters that make up the main view.
   * @type {!wtf.ui.Painter}
   * @private
   */
  this.painterStack_ = new wtf.ui.Painter(this.trackCanvas_);
  paintContext.addChildPainter(this.painterStack_);
  this.painterStack_.setLayoutMode(wtf.ui.LayoutMode.VERTICAL);

  /**
   * Ruler painter.
   * @type {!wtf.ui.RulerPainter}
   * @private
   */
  this.rulerPainter_ = new wtf.ui.RulerPainter(this.trackCanvas_);
  this.painterStack_.addChildPainter(this.rulerPainter_);
  this.rulerPainter_.setGranularities(
      wtf.app.ui.tracks.TracksPanel.MIN_GRANULARITY_,
      wtf.app.ui.tracks.TracksPanel.MAX_GRANULARITY_);
  this.timePainters_.push(this.rulerPainter_);

  var markPainter = new wtf.app.ui.MarkPainter(this.trackCanvas_, db);
  this.painterStack_.addChildPainter(markPainter);
  this.timePainters_.push(markPainter);

  // Watch for zones and add as needed.
  db.addListener(wtf.analysis.db.EventDatabase.EventType.ZONES_ADDED,
      function(zoneIndices) {
        goog.array.forEach(zoneIndices, this.addZoneTrack_, this);
      }, this);
  var zoneIndices = db.getZoneIndices();
  goog.array.forEach(zoneIndices, this.addZoneTrack_, this);

  // Done last so any other handlers are properly registered.
  this.viewport_.registerElement(this.trackCanvas_);

  wtf.timing.setImmediate(this.layout, this);
  this.requestRepaint();
};
goog.inherits(wtf.app.ui.tracks.TracksPanel, wtf.app.ui.TabPanel);


/**
 * @override
 */
wtf.app.ui.tracks.TracksPanel.prototype.createDom = function(dom) {
  return /** @type {!Element} */ (goog.soy.renderAsFragment(
      wtf.app.ui.tracks.trackspanel.control, undefined, undefined, dom));
};


/**
 * Sets up some simple keyboard shortcuts.
 * @private
 */
wtf.app.ui.tracks.TracksPanel.prototype.setupKeyboardShortcuts_ = function() {
  var db = this.db_;
  var viewport = this.viewport_;

  var commandManager = wtf.events.getCommandManager();
  var keyboardScope = this.keyboardScope_;

  keyboardScope.addShortcut('space', function() {
    var width = viewport.getScreenWidth();
    viewport.panDelta((width * 0.8) / viewport.getScale(), 0);
  }, this);
  keyboardScope.addShortcut('shift+space', function() {
    var width = viewport.getScreenWidth();
    viewport.panDelta(-(width * 0.8) / viewport.getScale(), 0);
  }, this);

  function moveFrames(delta, framesOnly) {
    // Find a frame index.
    var frameIndex = db.getFirstFrameIndex();
    if (!frameIndex) {
      return;
    }

    // Find center time.
    var time = viewport.screenToScene(viewport.getScreenWidth() / 2, 0).x;
    time += db.getFirstEventTime();

    // Find the frame at the center of the viewport.
    var hit = frameIndex.getFrameAtTime(time);
    if (hit) {
      // Frame, move to adjacent intra-frame space or frame.
      if (framesOnly) {
        var newFrame;
        if (delta < 0) {
          newFrame = frameIndex.getPreviousFrame(hit);
        } else {
          newFrame = frameIndex.getNextFrame(hit);
        }
        commandManager.execute('goto_frame', this, null, newFrame);
      } else {
        var startTime;
        var endTime;
        if (delta < 0) {
          var otherFrame = frameIndex.getPreviousFrame(hit);
          startTime = otherFrame ?
              otherFrame.getEndTime() : db.getFirstEventTime();
          endTime = hit.getStartTime();
        } else {
          var otherFrame = frameIndex.getNextFrame(hit);
          startTime = hit.getEndTime();
          endTime = otherFrame ?
              otherFrame.getStartTime() : db.getLastEventTime();
        }
        commandManager.execute('goto_range', this, null, startTime, endTime);
      }
    } else {
      // If in a intra-frame space, move to a frame.
      hit = frameIndex.getIntraFrameAtTime(time);
      if (hit) {
        var newFrame = delta < 0 ? hit[0] : hit[1];
        commandManager.execute('goto_frame', this, null, newFrame);
      }
    }
  };
  keyboardScope.addShortcut('z', function() {
    moveFrames(-1, true);
  }, this);
  keyboardScope.addShortcut('x', function() {
    moveFrames(1, true);
  }, this);
  keyboardScope.addShortcut('shift+z', function() {
    moveFrames(-1, false);
  }, this);
  keyboardScope.addShortcut('shift+x', function() {
    moveFrames(1, false);
  }, this);

  keyboardScope.addShortcut('left|a', function() {
    viewport.panDelta(-160 / viewport.getScale(), 0);
  }, this);
  keyboardScope.addShortcut('right|d', function() {
    viewport.panDelta(160 / viewport.getScale(), 0);
  }, this);
  keyboardScope.addShortcut('shift+left|shift+a', function() {
    viewport.panDelta(-160 * 3 / viewport.getScale(), 0);
  }, this);
  keyboardScope.addShortcut('shift+right|shift+d', function() {
    viewport.panDelta(160 * 3 / viewport.getScale(), 0);
  }, this);
  keyboardScope.addShortcut('up|w', function() {
    viewport.zoomDelta(2.5);
  }, this);
  keyboardScope.addShortcut('down|s', function() {
    viewport.zoomDelta(1 / 2.5);
  }, this);

  keyboardScope.addShortcut('home', function() {
    var firstEventTime = db.getFirstEventTime();
    var lastEventTime = db.getLastEventTime();
    commandManager.execute('goto_range', this, null,
        firstEventTime, lastEventTime);
  }, this);
};


/**
 * Minimum granularity, in ms.
 * @const
 * @type {number}
 * @private
 */
wtf.app.ui.tracks.TracksPanel.MIN_GRANULARITY_ =
    100 * wtf.analysis.db.Granularity.SECOND;


/**
 * Maximum granularity, in ms.
 * @const
 * @type {number}
 * @private
 */
wtf.app.ui.tracks.TracksPanel.MAX_GRANULARITY_ =
    0.001;


/**
 * @override
 */
wtf.app.ui.tracks.TracksPanel.prototype.setVisible = function(value) {
  goog.base(this, 'setVisible', value);
  this.keyboardScope_.setEnabled(value);
};


/**
 * @override
 */
wtf.app.ui.tracks.TracksPanel.prototype.navigate = function(pathParts) {
  // TODO(benvanik): support navigation
};


/**
 * @override
 */
wtf.app.ui.tracks.TracksPanel.prototype.layoutInternal = function() {
  var canvas = this.trackCanvas_;
  var canvasOuter = goog.dom.getParentElement(canvas);

  var infobarWidth = this.infobar_.getSplitterSize();
  goog.style.setStyle(canvasOuter, 'margin-right', (infobarWidth + 1) + 'px');

  var currentSize = goog.style.getSize(canvasOuter);
  this.viewport_.setScreenSize(currentSize.width, currentSize.height);
};


/**
 * Adds a new zone track for the given zone index.
 * @param {!wtf.analysis.db.ZoneIndex} zoneIndex Zone index to add the track
 *     for.
 * @private
 */
wtf.app.ui.tracks.TracksPanel.prototype.addZoneTrack_ = function(zoneIndex) {
  var zonePainterStack = new wtf.ui.Painter(this.trackCanvas_);
  this.painterStack_.addChildPainter(zonePainterStack);
  zonePainterStack.setLayoutMode(wtf.ui.LayoutMode.VERTICAL);
  zonePainterStack.setPadding(new goog.math.Rect(0, 5, 0, 5));

  var framePainter = new wtf.app.ui.FramePainter(
      this.trackCanvas_, this.db_, zoneIndex.getFrameIndex());
  zonePainterStack.addChildPainter(framePainter);
  this.timePainters_.push(framePainter);
  framePainter.setPadding(new goog.math.Rect(0, 0, 0, 5));

  var timeRangePainter = new wtf.app.ui.tracks.TimeRangePainter(
      this.trackCanvas_, this.db_, zoneIndex.getTimeRangeIndex());
  zonePainterStack.addChildPainter(timeRangePainter);
  this.timePainters_.push(timeRangePainter);
  timeRangePainter.setPadding(new goog.math.Rect(0, 0, 0, 5));

  var docView = this.getDocumentView();
  var zonePainter = new wtf.app.ui.tracks.ZonePainter(
      this.trackCanvas_, this.db_, zoneIndex, docView.getSelection());
  zonePainterStack.addChildPainter(zonePainter);
  this.timePainters_.push(zonePainter);
};
