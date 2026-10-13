#include "screen_gui.hpp"
#include "vex.h"
#include "movement.hpp"
#include "Odometry.hpp"
#include "motorcheck.hpp"
#include <cstdio>
#include <cstdlib>
#include <cstring>

/*---------------------------------------------------------------------------*/
/*                              Auton lists                                  */
/*---------------------------------------------------------------------------*/

// Order must match the switch in autonomous() (main.cpp).
// hint is shown under the buttons and on the locked screen; "" hides it.
struct AutonEntry {
  const char* name;
  const char* hint;
};

static const AutonEntry qualAutons[] = {
  {"Test",        ""},
  {"4 Pins Near", ""},
  {"4 Pins Side", ""},
};

static const AutonEntry elimAutons[] = {
  {"nothing", ""},
};

static const AutonEntry skillsAutons[] = {
  {"Skills", ""},
};

#define ARRAY_LEN(a) ((int)(sizeof(a) / sizeof((a)[0])))

struct TabInfo {
  const char* name;
  const AutonEntry* autons;
  int count;
};

static const TabInfo tabs[] = {
  {"QUALS",  qualAutons,   ARRAY_LEN(qualAutons)},
  {"ELIMS",  elimAutons,   ARRAY_LEN(elimAutons)},
  {"SKILLS", skillsAutons, ARRAY_LEN(skillsAutons)},
};
static const int TAB_COUNT = ARRAY_LEN(tabs);

// Two columns of four buttons.
static const int ROWS = 4;
static const int MAX_AUTONS = 2 * ROWS;
static_assert(ARRAY_LEN(qualAutons) <= MAX_AUTONS, "too many qual autons for the selector");
static_assert(ARRAY_LEN(elimAutons) <= MAX_AUTONS, "too many elim autons for the selector");
static_assert(ARRAY_LEN(skillsAutons) <= MAX_AUTONS, "too many skills autons for the selector");

/*---------------------------------------------------------------------------*/
/*                              Look and layout                              */
/*---------------------------------------------------------------------------*/

// Color palette: dark theme
static const char* C_BG          = "#000000"; // page background, text on light buttons
static const char* C_BAR         = "#1E1D1A"; // status bar
static const char* C_MUTED       = "#2A2823"; // idle buttons
static const char* C_MUTED_EDGE  = "#54514A"; // idle button border, divider
static const char* C_TEXT        = "#F2F2F2";
static const char* C_SUBTLE      = "#B6B09F"; // secondary text
static const char* C_ACCENT      = "#EAE4D5"; // selected buttons
static const char* C_ACCENT_EDGE = "#B6B09F";
static const char* C_CONFIRM      = "#F2F2F2";
static const char* C_CONFIRM_EDGE = "#B6B09F";
// Alliance colors are not in the palette; kept so red and blue stay distinguishable.
static const char* C_RED         = "#E0604E";
static const char* C_RED_EDGE    = "#B5483A";
static const char* C_BLUE        = "#4A7BA6";
static const char* C_BLUE_EDGE   = "#3A6285";

// The user area of the V5 screen is 480 x 240.
static const int SCREEN_W = 480;
static const int SCREEN_H = 240;
static const int BAR_H = 30;

// Left column: tabs, then pre-match checks.
static const int TAB_X = 6, TAB_Y = 38, TAB_W = 86, TAB_H = 36, TAB_PITCH = 44;
static const int CHECKS_Y = 168;
static const int DIVIDER_X = 100;

// Right pane: auton buttons, hint line, alliance and confirm buttons.
static const int PANE_X = 101, PANE_W = SCREEN_W - PANE_X;
static const int BTN_X = 109, BTN_COL_PITCH = 184, BTN_W = 178;
static const int BTN_Y = 38, BTN_H = 30, BTN_PITCH = 37;
static const int HINT_Y = 182, HINT_H = 19;
static const int BOTTOM_Y = 204, BOTTOM_H = 32;
static const int ALLY_X = 180, ALLY_W = 90;      // ALLY_X..CONFIRM end is centered in the pane
static const int CONFIRM_X = 280, CONFIRM_W = 120;

// Locked screen.
static const int FIGURE_X = 424, FIGURE_Y = 62; // head center; the figure spans about 100px down
static const int CHANGE_X = 366, CHANGE_Y = 196, CHANGE_W = 100, CHANGE_H = 34;

static const uint32_t DEBOUNCE_MS = 120;     // ignore a press this soon after the last release
static const uint32_t CHECK_PERIOD_MS = 1000;
static const int LOW_BATTERY_PCT = 50;
static const char* SAVE_FILE = "autosel.txt";

/*---------------------------------------------------------------------------*/
/*                                  State                                    */
/*---------------------------------------------------------------------------*/

enum SelectorState { SEL_OFF, SEL_SELECTING, SEL_CONFIRMED, SEL_DONE };
static volatile SelectorState selState = SEL_OFF;

// Remembered selection for each tab (1-based, like AutoSelectorVal).
static int tabSel[TAB_COUNT];

enum TargetKind { T_NONE, T_TAB, T_AUTON, T_ALLIANCE, T_CONFIRM, T_CHANGE };
struct Target {
  TargetKind kind;
  int index;
  bool operator==(const Target& o) const { return kind == o.kind && index == o.index; }
};
static const Target NO_TARGET = {T_NONE, 0};
static Target pressedTarget = NO_TARGET;
static uint32_t lastReleaseMs = 0;

enum ImuStatus { IMU_OK, IMU_CALIBRATING, IMU_MISSING };
struct Checks {
  int battery;
  ImuStatus imu;
  int missing;
  const char* firstMissing;
  bool operator!=(const Checks& o) const {
    return battery != o.battery || imu != o.imu || missing != o.missing || firstMissing != o.firstMissing;
  }
};
static Checks checks = {100, IMU_OK, 0, nullptr};

// Touch callbacks, the selector thread and endAutoSelector() all draw; one at a time.
static vex::mutex screenMutex;

static bool selectorOnScreen() {
  return selState == SEL_SELECTING || selState == SEL_CONFIRMED;
}

static const TabInfo& curTab() { return tabs[currentTab]; }

static const AutonEntry& curAuton() { return curTab().autons[AutoSelectorVal - 1]; }

// Keeps currentTab, tabSel and AutoSelectorVal in range and in sync.
static void syncSelection() {
  if (currentTab < 0 || currentTab >= TAB_COUNT) currentTab = 0;
  for (int t = 0; t < TAB_COUNT; t++) {
    if (tabSel[t] < 1 || tabSel[t] > tabs[t].count) tabSel[t] = 1;
  }
  AutoSelectorVal = tabSel[currentTab];
}

/*---------------------------------------------------------------------------*/
/*                             Saved selection                               */
/*---------------------------------------------------------------------------*/

// File format: "<tab> <sel per tab...> <red>"
static void saveSelection() {
  if (!Brain.SDcard.isInserted()) return;
  char buf[64];
  int n = snprintf(buf, sizeof(buf), "%d", currentTab);
  for (int t = 0; t < TAB_COUNT; t++) n += snprintf(buf + n, sizeof(buf) - n, " %d", tabSel[t]);
  n += snprintf(buf + n, sizeof(buf) - n, " %d\n", Red ? 1 : 0);
  Brain.SDcard.savefile(SAVE_FILE, (uint8_t*)buf, n);
}

static void loadSelection() {
  if (!Brain.SDcard.isInserted() || !Brain.SDcard.exists(SAVE_FILE)) return;
  char buf[64] = {};
  if (Brain.SDcard.loadfile(SAVE_FILE, (uint8_t*)buf, sizeof(buf) - 1) <= 0) return;

  int values[TAB_COUNT + 2];
  char* p = buf;
  for (int i = 0; i < TAB_COUNT + 2; i++) {
    char* end;
    values[i] = (int)strtol(p, &end, 10);
    if (end == p) return; // malformed file: keep defaults
    p = end;
  }
  currentTab = values[0];
  for (int t = 0; t < TAB_COUNT; t++) tabSel[t] = values[1 + t];
  Red = values[TAB_COUNT + 1] != 0;
}

/*---------------------------------------------------------------------------*/
/*                             Pre-match checks                              */
/*---------------------------------------------------------------------------*/

static Checks readChecks() {
  Checks c;
  c.battery = (int)Brain.Battery.capacity();
  c.imu = !Gyro.installed() ? IMU_MISSING : Gyro.isCalibrating() ? IMU_CALIBRATING : IMU_OK;
  c.missing = countMissingDevices(&c.firstMissing);
  return c;
}

struct CheckText {
  char text[32];
  bool bad;
};

// Battery, IMU and ports, plus the first missing device's name if any.
static int checkTexts(CheckText out[4]) {
  int n = 0;
  snprintf(out[n].text, sizeof(out[n].text), "BAT %d%%", checks.battery);
  out[n++].bad = checks.battery < LOW_BATTERY_PCT;

  const char* imu = checks.imu == IMU_OK ? "IMU OK" : checks.imu == IMU_CALIBRATING ? "IMU CAL..." : "IMU MISSING";
  snprintf(out[n].text, sizeof(out[n].text), "%s", imu);
  out[n++].bad = checks.imu != IMU_OK;

  if (checks.missing == 0) snprintf(out[n].text, sizeof(out[n].text), "PORTS OK");
  else snprintf(out[n].text, sizeof(out[n].text), "%d MISSING", checks.missing);
  out[n++].bad = checks.missing != 0;

  if (checks.missing > 0 && checks.firstMissing) {
    snprintf(out[n].text, sizeof(out[n].text), "%s", checks.firstMissing);
    out[n++].bad = true;
  }
  return n;
}

/*---------------------------------------------------------------------------*/
/*                             Drawing helpers                               */
/*---------------------------------------------------------------------------*/

// Solid rounded rectangle. Pen and fill share one color and pen width is 1 so
// the corner circles and the two cross rectangles merge without seams.
// Covers pixels x..x+w-1, y..y+h-1.
static void fillRoundRect(int x, int y, int w, int h, int r, const char* color) {
  Brain.Screen.setPenWidth(1);
  Brain.Screen.setPenColor(color);
  Brain.Screen.setFillColor(color);
  Brain.Screen.drawRectangle(x + r, y, w - 2 * r, h);
  Brain.Screen.drawRectangle(x, y + r, w, h - 2 * r);
  Brain.Screen.drawCircle(x + r,         y + r,         r);
  Brain.Screen.drawCircle(x + w - 1 - r, y + r,         r);
  Brain.Screen.drawCircle(x + r,         y + h - 1 - r, r);
  Brain.Screen.drawCircle(x + w - 1 - r, y + h - 1 - r, r);
}

// Rounded button with a 1px border: border-colored shape, fill inset by 1px.
static void drawRoundButton(int x, int y, int w, int h, int r, const char* fill, const char* border) {
  fillRoundRect(x, y, w, h, r, border);
  fillRoundRect(x + 1, y + 1, w - 2, h - 2, r - 1, fill);
}

static void fillRect(int x, int y, int w, int h, const char* color) {
  Brain.Screen.setPenWidth(1);
  Brain.Screen.setPenColor(color);
  Brain.Screen.setFillColor(color);
  Brain.Screen.drawRectangle(x, y, w, h);
}

// Text is drawn transparent so it never paints a box behind itself.
static void textAt(int x, int y, const char* s) {
  Brain.Screen.printAt(x, y, false, "%s", s);
}

static void textCentered(int x, int w, int y, const char* s) {
  textAt(x + (w - Brain.Screen.getStringWidth(s)) / 2, y, s);
}

// Copies text into out, cutting it short with ".." until it fits maxWidth in the current font.
static void fitText(const char* text, char* out, int outSize, int maxWidth) {
  int len = (int)strlen(text);
  snprintf(out, outSize, "%s", text);
  for (int n = len - 1; n >= 0 && Brain.Screen.getStringWidth(out) > maxWidth; n--) {
    snprintf(out, outSize, "%.*s..", n, text);
  }
}

// Small rounded label; returns its width.
static int drawPill(int x, int y, const char* text, const char* fill, const char* textColor) {
  Brain.Screen.setFont(monoS);
  int w = Brain.Screen.getStringWidth(text) + 16;
  fillRoundRect(x, y, w, 20, 6, fill);
  Brain.Screen.setPenColor(textColor);
  textAt(x + 8, y + 14, text);
  return w;
}

static const char* allianceColor() { return Red ? C_RED : C_BLUE; }
static const char* allianceEdge() { return Red ? C_RED_EDGE : C_BLUE_EDGE; }
static const char* allianceName() { return Red ? "RED" : "BLUE"; }

/*---------------------------------------------------------------------------*/
/*                             Selector screen                               */
/*---------------------------------------------------------------------------*/

struct Rect {
  int x, y, w, h;
  bool contains(int px, int py) const { return px >= x && px < x + w && py >= y && py < y + h; }
};

static Rect tabRect(int i) { return {TAB_X, TAB_Y + i * TAB_PITCH, TAB_W, TAB_H}; }

// Left column fills first.
static Rect autonRect(int i) {
  int leftCount = (curTab().count + 1) / 2;
  int col = i < leftCount ? 0 : 1;
  int row = i < leftCount ? i : i - leftCount;
  return {BTN_X + col * BTN_COL_PITCH, BTN_Y + row * BTN_PITCH, BTN_W, BTN_H};
}

static const Rect ALLY_RECT    = {ALLY_X, BOTTOM_Y, ALLY_W, BOTTOM_H};
static const Rect CONFIRM_RECT = {CONFIRM_X, BOTTOM_Y, CONFIRM_W, BOTTOM_H};
static const Rect CHANGE_RECT  = {CHANGE_X, CHANGE_Y, CHANGE_W, CHANGE_H};

static void drawTab(int i, bool pressed) {
  Rect r = tabRect(i);
  bool selected = i == currentTab;
  const char* edge = selected ? C_ACCENT_EDGE : C_MUTED_EDGE;
  drawRoundButton(r.x, r.y, r.w, r.h, 6, pressed ? edge : (selected ? C_ACCENT : C_MUTED), edge);
  Brain.Screen.setFont(monoM);
  Brain.Screen.setPenColor(selected ? C_BG : C_TEXT);
  textCentered(r.x, r.w, r.y + 23, tabs[i].name);
}

static void drawAutonButton(int i, bool pressed) {
  Rect r = autonRect(i);
  bool selected = AutoSelectorVal == i + 1;
  const char* edge = selected ? C_ACCENT_EDGE : C_MUTED_EDGE;
  drawRoundButton(r.x, r.y, r.w, r.h, 6, pressed ? edge : (selected ? C_ACCENT : C_MUTED), edge);

  Brain.Screen.setFont(monoM);
  Brain.Screen.setPenColor(selected ? C_BG : C_TEXT);
  if (selected) textAt(r.x + 8, r.y + 20, ">");
  char label[40];
  fitText(curTab().autons[i].name, label, sizeof(label), r.w - 30);
  textAt(r.x + 22, r.y + 20, label);
}

static void drawAllianceToggle(bool pressed) {
  const Rect& r = ALLY_RECT;
  drawRoundButton(r.x, r.y, r.w, r.h, 6, pressed ? allianceEdge() : allianceColor(), allianceEdge());
  Brain.Screen.setFont(monoM);
  Brain.Screen.setPenColor(C_TEXT);
  textCentered(r.x, r.w, r.y + 21, allianceName());
}

static void drawConfirmButton(bool pressed) {
  const Rect& r = CONFIRM_RECT;
  drawRoundButton(r.x, r.y, r.w, r.h, 6, pressed ? C_CONFIRM_EDGE : C_CONFIRM, C_CONFIRM_EDGE);
  Brain.Screen.setFont(monoM);
  Brain.Screen.setPenColor(C_BG);
  textCentered(r.x, r.w, r.y + 21, "CONFIRM");
}

static void drawChangeButton(bool pressed) {
  const Rect& r = CHANGE_RECT;
  drawRoundButton(r.x, r.y, r.w, r.h, 6, pressed ? C_MUTED_EDGE : C_MUTED, C_MUTED_EDGE);
  Brain.Screen.setFont(monoM);
  Brain.Screen.setPenColor(C_TEXT);
  textCentered(r.x, r.w, r.y + 22, "CHANGE");
}

// [TAB]  Auton name ...................... [RED]
static void drawStatusBar() {
  fillRect(0, 0, SCREEN_W, BAR_H, C_BAR);
  int nameX = 6 + drawPill(6, 5, curTab().name, C_MUTED, C_TEXT) + 10;

  Brain.Screen.setFont(monoS);
  int allyX = SCREEN_W - 6 - (Brain.Screen.getStringWidth(allianceName()) + 16);
  drawPill(allyX, 5, allianceName(), allianceColor(), C_TEXT);

  Brain.Screen.setFont(monoM);
  Brain.Screen.setPenColor(C_TEXT);
  char name[40];
  fitText(curAuton().name, name, sizeof(name), allyX - 10 - nameX);
  textAt(nameX, 21, name);
}

static void drawHint() {
  fillRect(PANE_X + 1, HINT_Y, PANE_W - 1, HINT_H, C_BG);
  Brain.Screen.setFont(monoS);
  Brain.Screen.setPenColor(C_SUBTLE);
  char hint[64];
  fitText(curAuton().hint, hint, sizeof(hint), PANE_W - 20);
  textCentered(PANE_X, PANE_W, HINT_Y + 14, hint);
}

// Buttons and hint; only needed when the tab changes.
static void drawAutonArea() {
  fillRect(PANE_X + 1, BAR_H, PANE_W - 1, HINT_Y - BAR_H, C_BG);
  for (int i = 0; i < curTab().count; i++) drawAutonButton(i, false);
  drawHint();
}

static void drawChecksColumn() {
  fillRect(0, CHECKS_Y, DIVIDER_X - 2, SCREEN_H - CHECKS_Y, C_BG);
  CheckText lines[4];
  int n = checkTexts(lines);
  Brain.Screen.setFont(monoS);
  for (int i = 0; i < n; i++) {
    char text[32];
    fitText(lines[i].text, text, sizeof(text), DIVIDER_X - 12);
    Brain.Screen.setPenColor(lines[i].bad ? C_RED : C_TEXT);
    textAt(8, CHECKS_Y + 14 + i * 16, text);
  }
}

static void drawSelector() {
  fillRect(0, 0, SCREEN_W, SCREEN_H, C_BG);
  drawStatusBar();
  for (int i = 0; i < TAB_COUNT; i++) drawTab(i, false);

  Brain.Screen.setPenColor(C_MUTED_EDGE);
  Brain.Screen.setPenWidth(2);
  Brain.Screen.drawLine(DIVIDER_X, BAR_H, DIVIDER_X, SCREEN_H);
  Brain.Screen.setPenWidth(1);

  drawAutonArea();
  drawAllianceToggle(false);
  drawConfirmButton(false);
  drawChecksColumn();
}

/*---------------------------------------------------------------------------*/
/*                              Locked screen                                */
/*---------------------------------------------------------------------------*/

static void drawChecksLine() {
  fillRect(28, 212, CHANGE_X - 32, 24, C_BG);
  CheckText parts[4];
  int n = checkTexts(parts);
  Brain.Screen.setFont(monoS);
  int x = 28;
  for (int i = 0; i < n; i++) {
    int w = Brain.Screen.getStringWidth(parts[i].text);
    if (x + w > CHANGE_X - 8) break;
    Brain.Screen.setPenColor(parts[i].bad ? C_RED : C_TEXT);
    textAt(x, 228, parts[i].text);
    x += w + 14;
  }
}

static void drawFigure(int centerX, int centerY);
void drawFilledEllipse(int X, int Y, int radiusX, int radiusY);

static void drawLockedScreen() {
  fillRect(0, 0, SCREEN_W, SCREEN_H, C_BG);
  fillRect(0, 0, 12, SCREEN_H, allianceColor()); // alliance color, readable from across the field

  Brain.Screen.setFont(monoS);
  Brain.Screen.setPenColor(C_SUBTLE);
  textAt(28, 30, "AUTON LOCKED IN");

  int x = 28 + drawPill(28, 42, curTab().name, C_MUTED, C_TEXT) + 8;
  drawPill(x, 42, allianceName(), allianceColor(), C_TEXT);

  // Largest font the name fits in.
  drawFigure(FIGURE_X, FIGURE_Y);

  const int maxW = FIGURE_X - 50 - 28; // leave room for the figure's arms
  Brain.Screen.setPenColor(C_TEXT);
  Brain.Screen.setFont(mono40);
  if (Brain.Screen.getStringWidth(curAuton().name) <= maxW) {
    textAt(28, 120, curAuton().name);
  } else {
    Brain.Screen.setFont(mono30);
    if (Brain.Screen.getStringWidth(curAuton().name) <= maxW) {
      textAt(28, 116, curAuton().name);
    } else {
      Brain.Screen.setFont(monoM);
      char name[64];
      fitText(curAuton().name, name, sizeof(name), maxW);
      textAt(28, 112, name);
    }
  }

  Brain.Screen.setFont(monoS);
  Brain.Screen.setPenColor(C_SUBTLE);
  char hint[64];
  fitText(curAuton().hint, hint, sizeof(hint), maxW);
  textAt(28, 148, hint);

  drawChecksLine();
  drawChangeButton(false);
}

/*---------------------------------------------------------------------------*/
/*                                 Actions                                   */
/*---------------------------------------------------------------------------*/

static void selectTab(int i) {
  if (i == currentTab) return;
  int old = currentTab;
  currentTab = i;
  AutoSelectorVal = tabSel[i];
  drawTab(old, false);
  drawTab(i, false);
  drawAutonArea();
  drawStatusBar();
}

static void selectAuton(int val) {
  if (val == AutoSelectorVal) return;
  int old = AutoSelectorVal;
  AutoSelectorVal = val;
  tabSel[currentTab] = val;
  drawAutonButton(old - 1, false);
  drawAutonButton(val - 1, false);
  drawHint();
  drawStatusBar();
}

static void toggleAlliance() {
  Red = !Red;
  drawAllianceToggle(false);
  drawStatusBar();
}

static void confirmSelection() {
  selState = SEL_CONFIRMED;
  EXIT = true;
  saveSelection();
  drawLockedScreen();
}

static void reopenSelector() {
  selState = SEL_SELECTING;
  EXIT = false;
  drawSelector();
}

/*---------------------------------------------------------------------------*/
/*                                  Touch                                    */
/*---------------------------------------------------------------------------*/

// Only real button areas count; gaps between buttons hit nothing.
static Target hitTest(int x, int y) {
  if (selState == SEL_SELECTING) {
    for (int i = 0; i < TAB_COUNT; i++) {
      if (tabRect(i).contains(x, y)) return {T_TAB, i};
    }
    for (int i = 0; i < curTab().count; i++) {
      if (autonRect(i).contains(x, y)) return {T_AUTON, i};
    }
    if (ALLY_RECT.contains(x, y)) return {T_ALLIANCE, 0};
    if (CONFIRM_RECT.contains(x, y)) return {T_CONFIRM, 0};
  } else if (selState == SEL_CONFIRMED) {
    if (CHANGE_RECT.contains(x, y)) return {T_CHANGE, 0};
  }
  return NO_TARGET;
}

static void drawTarget(Target t, bool pressed) {
  switch (t.kind) {
    case T_TAB:      drawTab(t.index, pressed); break;
    case T_AUTON:    drawAutonButton(t.index, pressed); break;
    case T_ALLIANCE: drawAllianceToggle(pressed); break;
    case T_CONFIRM:  drawConfirmButton(pressed); break;
    case T_CHANGE:   drawChangeButton(pressed); break;
    case T_NONE:     break;
  }
}

static void doAction(Target t) {
  switch (t.kind) {
    case T_TAB:      selectTab(t.index); break;
    case T_AUTON:    selectAuton(t.index + 1); break;
    case T_ALLIANCE: toggleAlliance(); break;
    case T_CONFIRM:  confirmSelection(); break;
    case T_CHANGE:   reopenSelector(); break;
    case T_NONE:     break;
  }
}

// Press only highlights; the action happens on release.
static void onScreenPressed() {
  screenMutex.lock();
  if (selectorOnScreen() && Brain.Timer.system() - lastReleaseMs >= DEBOUNCE_MS) {
    pressedTarget = hitTest(Brain.Screen.xPosition(), Brain.Screen.yPosition());
    drawTarget(pressedTarget, true);
  }
  screenMutex.unlock();
}

// Acts only if the finger lifts on the same button it pressed, so sliding off cancels.
static void onScreenReleased() {
  screenMutex.lock();
  if (selectorOnScreen() && pressedTarget.kind != T_NONE) {
    Target t = pressedTarget;
    pressedTarget = NO_TARGET;
    drawTarget(t, false);
    if (hitTest(Brain.Screen.xPosition(), Brain.Screen.yPosition()) == t) doAction(t);
    lastReleaseMs = Brain.Timer.system();
  }
  screenMutex.unlock();
}

/*---------------------------------------------------------------------------*/
/*                       Controller and background task                      */
/*---------------------------------------------------------------------------*/

// Controller input and check refresh, until the match starts. Nothing is drawn on the controller screen.
// Controller: Left/Right tab, Up/Down auton, X alliance, A confirm, B change after confirming.
static int selectorTask() {
  enum { B_LEFT, B_RIGHT, B_UP, B_DOWN, B_X, B_A, B_B, B_COUNT };
  bool prev[B_COUNT] = {};
  uint32_t lastCheckMs = Brain.Timer.system();

  while (selState != SEL_DONE) {
    bool now[B_COUNT] = {
      Controller1.ButtonLeft.pressing(), Controller1.ButtonRight.pressing(),
      Controller1.ButtonUp.pressing(),   Controller1.ButtonDown.pressing(),
      Controller1.ButtonX.pressing(),    Controller1.ButtonA.pressing(),
      Controller1.ButtonB.pressing(),
    };
    bool edge[B_COUNT];
    for (int i = 0; i < B_COUNT; i++) edge[i] = now[i] && !prev[i];

    screenMutex.lock();
    if (selState == SEL_SELECTING) {
      int count = curTab().count;
      if (edge[B_LEFT])  selectTab((currentTab + TAB_COUNT - 1) % TAB_COUNT);
      if (edge[B_RIGHT]) selectTab((currentTab + 1) % TAB_COUNT);
      if (edge[B_UP])    selectAuton(AutoSelectorVal > 1 ? AutoSelectorVal - 1 : count);
      if (edge[B_DOWN])  selectAuton(AutoSelectorVal < count ? AutoSelectorVal + 1 : 1);
      if (edge[B_X])     toggleAlliance();
      if (edge[B_A])     confirmSelection();
    } else if (selState == SEL_CONFIRMED) {
      if (edge[B_B])     reopenSelector();
    }

    if (selectorOnScreen() && Brain.Timer.system() - lastCheckMs >= CHECK_PERIOD_MS) {
      lastCheckMs = Brain.Timer.system();
      Checks c = readChecks();
      if (c != checks) {
        checks = c;
        if (selState == SEL_SELECTING) drawChecksColumn();
        else drawChecksLine();
      }
    }
    screenMutex.unlock();

    for (int i = 0; i < B_COUNT; i++) prev[i] = now[i];
    wait(20, msec);
  }
  return 0;
}

/*---------------------------------------------------------------------------*/
/*                                Public API                                 */
/*---------------------------------------------------------------------------*/

void DisplayAutoSelector(void) {
  screenMutex.lock();
  if (currentTab < 0 || currentTab >= TAB_COUNT) currentTab = 0;
  for (int t = 0; t < TAB_COUNT; t++) tabSel[t] = 1;
  tabSel[currentTab] = AutoSelectorVal;
  loadSelection();
  syncSelection();
  checks = readChecks();
  pressedTarget = NO_TARGET;
  selState = SEL_SELECTING;
  EXIT = false;
  drawSelector();
  screenMutex.unlock();

  static bool started = false;
  if (!started) {
    started = true;
    Brain.Screen.pressed(onScreenPressed);
    Brain.Screen.released(onScreenReleased);
    vex::thread task(selectorTask);
  }
}

void endAutoSelector() {
  screenMutex.lock();
  bool wasShown = selectorOnScreen();
  selState = SEL_DONE;
  EXIT = true;
  pressedTarget = NO_TARGET;
  if (wasShown) fillRect(0, 0, SCREEN_W, SCREEN_H, C_BG);
  screenMutex.unlock();
}

/*---------------------------------------------------------------------------*/
/*                          Other display helpers                            */
/*---------------------------------------------------------------------------*/

void drawEllipse(int X, int Y, int radiusX, int radiusY) {

    // Step through angles from 0 to 360 degrees (in radians)
    // Decreasing the step size (0.02) makes the ellipse smoother
    for (float angle = 0; angle < 2 * M_PI; angle += 0.02) {
        int x = X + (radiusX * cos(angle));
        int y = Y + (radiusY * sin(angle));

        Brain.Screen.drawPixel(x, y);
    }
}

void drawFilledEllipse(int X, int Y, int radiusX, int radiusY) {

    // Loop through each vertical row from the top of the ellipse to the bottom
    for (int yOffset = -radiusY; yOffset <= radiusY; yOffset++) {
        // Calculate the half-width of the ellipse at this specific row using the ellipse equation:
        // (x/a)^2 + (y/b)^2 = 1  -->  x = a * sqrt(1 - (y/b)^2)
        int xOffset = round(radiusX * sqrt(1.0 - (double)(yOffset * yOffset) / (radiusY * radiusY)));

        // Draw a horizontal line from the left edge to the right edge of this row
        int leftX = X - xOffset;
        int rightX = X + xOffset;
        int currentY = Y + yOffset;

        Brain.Screen.drawLine(leftX, currentY, rightX, currentY);
    }
}

// The stick figure: head, body, arms and legs, centered on the head.
static void drawFigure(int centerX, int centerY) {
  int faceRadius = 30;

  // Draw yellow face
  Brain.Screen.setFillColor("#FFD700");
  Brain.Screen.setPenColor("#D4AF37");
  Brain.Screen.drawCircle(centerX, centerY, faceRadius);

  // Draw eyes (simple dots)
  Brain.Screen.setFillColor("#000000");
  Brain.Screen.setPenColor("#000000");
  //Brain.Screen.drawLine(centerX-5, centerY -3, centerX - 13, centerY  -7);
  //Brain.Screen.drawLine(centerX+5, centerY -3 , centerX+13 , centerY -7);
  Brain.Screen.drawCircle(centerX - 8, centerY - 3, 3);
  Brain.Screen.drawCircle(centerX + 8, centerY - 3, 3);

  // Draw smile (simple line)
  Brain.Screen.setPenColor("#000000");
  Brain.Screen.setPenWidth(2);
  Brain.Screen.drawLine(centerX - 8, centerY + 7, centerX + 8, centerY + 7); // draws mouth

  Brain.Screen.setPenColor("#D4AF37");
  Brain.Screen.setFillColor("#D4AF37");
  Brain.Screen.drawLine(centerX, centerY + faceRadius, centerX, centerY + 70);
  drawFilledEllipse(centerX, centerY + (faceRadius+70)/2.0,10, 20);
  Brain.Screen.drawLine(centerX-35, centerY + 45, centerX+35, centerY + 45);
  Brain.Screen.drawLine(centerX, centerY +70, centerX+30, centerY + 100);
  Brain.Screen.drawLine(centerX, centerY +70, centerX-30, centerY + 100);
  Brain.Screen.setPenWidth(1);
}

void drawSmileyFace() {
  int centerX = 200;
  int centerY = 128;
  drawFigure(centerX, centerY);
  Brain.Screen.setPenColor("#D4AF37");
  Brain.Screen.setPenWidth(2);

  Brain.Screen.drawLine(centerX+50, centerY , centerX+62, centerY +10);
  Brain.Screen.drawLine(centerX+50, centerY , centerX+62, centerY -10);
  Brain.Screen.drawLine(centerX+50, centerY , centerX+100, centerY );

  Brain.Screen.setFillColor(C_BG);
  Brain.Screen.setFont(mono20);
  Brain.Screen.printAt(centerX+ 110, centerY+4, "Brin");

}

void display_odom(){
  if (selectorOnScreen()) return; // odom thread runs during pre-auton; keep it off the selector
  Brain.Screen.setFillColor(C_MUTED);
  Brain.Screen.setPenColor(C_MUTED_EDGE);
  Brain.Screen.drawRectangle(4,10, 130, 80);
  Brain.Screen.setFont(mono20);
  Brain.Screen.setPenColor(C_TEXT);
  Brain.Screen.setCursor(2, 3);
  Brain.Screen.print("X: %.2f", x_pos);
  Brain.Screen.setCursor(3, 3);
  Brain.Screen.print("Y: %.2f", y_pos);
  Brain.Screen.setCursor(4, 3);
  Brain.Screen.print("H: %.1f°", Gyro.heading(degrees));
}
