import { test } from "node:test";
import assert from "node:assert/strict";
import { actionLabel, handLabel, streetLabel, translate } from "./locale.ts";

test("both language preferences translate actions, hand labels and UI copy", () => {
  assert.equal(translate("创建房间", "en"), "Create room");
  assert.equal(translate("Fold", "zh"), "弃牌");
  assert.equal(actionLabel("Raise to 150", "zh"), "加注到 150");
  assert.equal(handLabel(3, "zh"), "三条");
  assert.equal(handLabel(3, "en"), "Triple");
  assert.equal(streetLabel("complete", "en"), "Hand complete");
  assert.equal(translate("某玩家", "en"), "某玩家", "unknown text is never translated as a player name");
});
