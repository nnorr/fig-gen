import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profiles = JSON.parse(fs.readFileSync(path.join(root, 'profiles', 'print-profiles.json'), 'utf8'));

test('profiles respect the CONVENTIONS floors (6 pt text, 0.5 pt strokes) and ship 1col + 2col', () => {
  assert.ok(profiles.font_pt.hard_min >= 6);
  for (const [id, profile] of Object.entries(profiles.profiles)) {
    assert.ok(profile.variants['1col'] && profile.variants['2col'], `${id} needs 1col and 2col`);
    for (const [vid, v] of Object.entries(profile.variants)) {
      assert.ok(v.min_font_pt >= 6, `${id}.${vid} min_font_pt`);
      assert.ok(v.warn_font_pt >= v.min_font_pt, `${id}.${vid} warn_font_pt`);
      assert.ok(v.min_stroke_pt >= 0.5, `${id}.${vid} min_stroke_pt`);
      assert.ok(v.width_pt > 0 && v.max_height_pt > 0, `${id}.${vid} size`);
    }
    assert.ok(profile.variants['1col'].width_pt < profile.variants['2col'].width_pt);
  }
});

test('every example names an existing profile and existing variants', () => {
  const dir = path.join(root, 'examples');
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const { print } = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')).meta;
    const profile = profiles.profiles[print.profile];
    assert.ok(profile, `${file}: unknown profile ${print.profile}`);
    for (const v of print.variants || Object.keys(profile.variants)) assert.ok(profile.variants[v], `${file}: unknown variant ${v}`);
  }
});
