import { describe, expect, it } from 'vitest';
import { extentFromEsriXml, extentFromWorldFile, parseWorldFile, resolutionFromEsriXml } from './tfw.ts';

describe('DEFRA metadata parsing', () => {
  it('turns a TFW centre-origin transform into edge extents', () => {
    const world = parseWorldFile(['1.0000000000', '0', '0', '-1.0000000000', '455000.5000000000', '209999.5000000000'].join('\n'));
    expect(extentFromWorldFile(world, 5000, 5000)).toEqual({
      eastMin: 455000,
      eastMax: 460000,
      northMin: 205000,
      northMax: 210000,
    });
  });

  it('extracts ESRI XML extent and metre resolution', () => {
    const xml = [
      '<westBL Sync="TRUE">455000.000000</westBL>',
      '<eastBL Sync="TRUE">460000.000000</eastBL>',
      '<southBL Sync="TRUE">205000.000000</southBL>',
      '<northBL Sync="TRUE">210000.000000</northBL>',
      '<dimResol><value Sync="TRUE" uom="m">1.000000</value></dimResol>',
    ].join('');
    expect(extentFromEsriXml(xml)).toEqual({
      eastMin: 455000,
      eastMax: 460000,
      northMin: 205000,
      northMax: 210000,
    });
    expect(resolutionFromEsriXml(xml)).toBe(1);
  });
});
