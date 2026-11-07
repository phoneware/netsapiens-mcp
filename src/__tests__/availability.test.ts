import { describe, expect, it } from 'vitest';
import {
  resolveDocsBranch,
  lookupObservation,
  compareVersions,
  isAvailable,
  getAvailabilityMeta,
  buildAvailability,
  createAvailabilityContext,
  getDefaultAvailabilityContext,
  type ObservationInfo,
  type AvailabilityData,
} from '../netsapiens/availability.js';
import type { VersionInfo } from '../netsapiens/version.js';

describe('src/netsapiens/availability.ts', () => {
  const branches = ['44.3', '44.4', '45.0', '46.0'];

  describe('compareVersions', () => {
    it('compares version strings numerically', () => {
      expect(compareVersions('44.4.10', '44.4.8')).toBeGreaterThan(0);
      expect(compareVersions('44.4.8', '44.4.10')).toBeLessThan(0);
      expect(compareVersions('44.4.10', '44.4.10')).toBe(0);
      expect(compareVersions('44.5.2', '44.4.10')).toBeGreaterThan(0);
      expect(compareVersions('45.0', '44.4.10')).toBeGreaterThan(0);
      expect(compareVersions('46.0.2', '45.2.1')).toBeGreaterThan(0);
    });
  });

  describe('resolveDocsBranch', () => {
    it('handles exact matches', () => {
      expect(resolveDocsBranch('44.3.0', branches)).toEqual({
        docsBranch: '44.3',
        match: 'exact',
        line: '44.3',
      });
      expect(resolveDocsBranch('44.4.10', branches)).toEqual({
        docsBranch: '44.4',
        match: 'exact',
        line: '44.4',
      });
      expect(resolveDocsBranch('45.0.0', branches)).toEqual({
        docsBranch: '45.0',
        match: 'exact',
        line: '45.0',
      });
      expect(resolveDocsBranch('46.0.2', branches)).toEqual({
        docsBranch: '46.0',
        match: 'exact',
        line: '46.0',
      });
    });

    it('handles nearest-lower matches', () => {
      expect(resolveDocsBranch('44.5.2', branches)).toEqual({
        docsBranch: '44.4',
        match: 'nearest-lower',
        line: '44.5',
      });
      expect(resolveDocsBranch('45.2.1', branches)).toEqual({
        docsBranch: '45.0',
        match: 'nearest-lower',
        line: '45.2',
      });
    });

    it('handles newer-than-documented versions using 46.0', () => {
      expect(resolveDocsBranch('46.1.0', branches)).toEqual({
        docsBranch: '46.0',
        match: 'newer-than-documented',
        line: '46.1',
      });
      expect(resolveDocsBranch('47.0.0', branches)).toEqual({
        docsBranch: '46.0',
        match: 'newer-than-documented',
        line: '47.0',
      });
    });

    it('handles older-than-documented versions as older-than-documented', () => {
      expect(resolveDocsBranch('43.0.0', branches)).toEqual({
        docsBranch: null,
        match: 'older-than-documented',
        line: '43.0',
      });
      expect(resolveDocsBranch('44.2.0', branches)).toEqual({
        docsBranch: null,
        match: 'older-than-documented',
        line: '44.2',
      });
    });

    it('handles null, undefined, and unparseable versions', () => {
      expect(resolveDocsBranch(null, branches)).toEqual({
        docsBranch: null,
        match: null,
        line: null,
      });
      expect(resolveDocsBranch(undefined, branches)).toEqual({
        docsBranch: null,
        match: null,
        line: null,
      });
      expect(resolveDocsBranch('invalid', branches)).toEqual({
        docsBranch: null,
        match: null,
        line: null,
      });
    });
  });

  describe('lookupObservation', () => {
    const observations: ObservationInfo[] = [
      { apiVersion: '44.4.10', line: '44.4' },
      { apiVersion: '44.4.20', line: '44.4' },
      { apiVersion: '44.5.2', line: '44.5' },
    ];

    it('picks the highest observed version <= host version in same line', () => {
      expect(lookupObservation('44.4', '44.4.15', observations)).toBe('44.4.10');
      expect(lookupObservation('44.4', '44.4.20', observations)).toBe('44.4.20');
      expect(lookupObservation('44.4', '44.4.25', observations)).toBe('44.4.20');
    });

    it('picks the lowest in line if none is <= host version', () => {
      expect(lookupObservation('44.4', '44.4.5', observations)).toBe('44.4.10');
    });

    it('returns null when no observation exists for the line', () => {
      expect(lookupObservation('45.0', '45.0.1', observations)).toBeNull();
      expect(lookupObservation('46.0', '46.0.0', observations)).toBeNull();
    });

    it('returns null on missing line or version', () => {
      expect(lookupObservation(null, '44.4.10', observations)).toBeNull();
      expect(lookupObservation('44.4', null, observations)).toBeNull();
    });
  });

  describe('isAvailable', () => {
    const mockData: AvailabilityData = {
      schemaVersion: 2,
      branches: ['44.3', '44.4', '45.0', '46.0'],
      observations: [],
      v2: {
        'GET /baseline': {
          branches: ['44.3', '44.4', '45.0', '46.0'],
          documented: ['44.3', '44.4', '45.0', '46.0'],
          observed: {},
        },
        'GET /documented-45': {
          branches: ['45.0', '46.0'],
          documented: ['45.0', '46.0'],
          observed: {},
        },
        'GET /observed-present': {
          branches: ['46.0'],
          documented: ['46.0'],
          observed: {
            '44.4.10': 'present',
          },
        },
        'GET /observed-absent': {
          branches: ['45.0', '46.0'],
          documented: ['45.0', '46.0'],
          observed: {
            '44.4.10': 'absent',
          },
        },
        'POST /write-45': {
          branches: ['45.0', '46.0'],
          documented: ['45.0', '46.0'],
          observed: {
            '44.4.10': 'present', // Observations only apply to GET!
          },
        },
      },
      v1: {
        'POST ?object=user&action=create': {
          branches: ['44.4.10'],
          documented: ['44.4.10'],
        },
      },
    };

    it('checks v2 GET with observation deciding', () => {
      const vInfo: Partial<VersionInfo> = {
        apiVersion: '44.4.10',
        docsBranch: '44.4',
        status: 'ok',
        observation: '44.4.10',
      };
      // Observed present -> available
      expect(isAvailable('GET /observed-present', vInfo as VersionInfo, mockData)).toBe(true);
      // Observed absent -> unavailable
      expect(isAvailable('GET /observed-absent', vInfo as VersionInfo, mockData)).toBe(false);
    });

    it('ensures observations only apply to GET operations', () => {
      const vInfo: Partial<VersionInfo> = {
        apiVersion: '44.4.10',
        docsBranch: '44.4',
        status: 'ok',
        observation: '44.4.10',
      };
      // Write key does not use observation; follows documented branch
      expect(isAvailable('POST /write-45', vInfo as VersionInfo, mockData)).toBe(false);

      const vInfo45: Partial<VersionInfo> = {
        apiVersion: '45.0.0',
        docsBranch: '45.0',
        status: 'ok',
        observation: null,
      };
      expect(isAvailable('POST /write-45', vInfo45 as VersionInfo, mockData)).toBe(true);
    });

    it('restricts unknown status and older-than-documented to baseline only', () => {
      const vUnknown: Partial<VersionInfo> = {
        apiVersion: null,
        docsBranch: null,
        status: 'unknown',
        observation: null,
      };
      expect(isAvailable('GET /baseline', vUnknown as VersionInfo, mockData)).toBe(true);
      expect(isAvailable('GET /documented-45', vUnknown as VersionInfo, mockData)).toBe(false);

      const vOlder: Partial<VersionInfo> = {
        apiVersion: '43.0.0',
        docsBranch: null,
        match: 'older-than-documented',
        status: 'ok',
        observation: null,
      };
      expect(isAvailable('GET /baseline', vOlder as VersionInfo, mockData)).toBe(true);
      expect(isAvailable('GET /documented-45', vOlder as VersionInfo, mockData)).toBe(false);
    });

    it('checks v1 tools against host v1 inventory', () => {
      const v1Ok: Partial<VersionInfo> = {
        apiVersion: '44.4.10',
        docsBranch: '44.4',
        status: 'ok',
        v1: 'ok',
        v1Keys: new Set(['POST ?object=user&action=create']),
      };
      expect(isAvailable('POST ?object=user&action=create', v1Ok as VersionInfo, mockData)).toBe(true);

      const v1Unavailable: Partial<VersionInfo> = {
        apiVersion: '44.4.10',
        docsBranch: '44.4',
        status: 'ok',
        v1: 'unavailable',
        v1Keys: new Set(),
      };
      expect(isAvailable('POST ?object=user&action=create', v1Unavailable as VersionInfo, mockData)).toBe(false);
    });
  });

  describe('buildAvailability helper', () => {
    it('creates custom availability data with extraPresent and extraAbsent', () => {
      const custom = buildAvailability({
        extraPresent: {
          '45.2.1': ['GET /custom-present'],
        },
        extraAbsent: {
          '45.2.1': ['GET /custom-absent'],
        },
      });

      expect(custom.schemaVersion).toBe(2);
      expect(custom.v2['GET /custom-present']?.observed?.['45.2.1']).toBe('present');
      expect(custom.v2['GET /custom-absent']?.observed?.['45.2.1']).toBe('absent');
    });
  });

  describe('createAvailabilityContext & getDefaultAvailabilityContext', () => {
    it('provides context with isAvailable and getToolAvailability', () => {
      const defContext = getDefaultAvailabilityContext();
      expect(defContext.versionInfo.apiVersion).toBe('46.0.0');
      expect(defContext.isAvailable('GET /apikeys/{}')).toBe(true);

      const meta = defContext.getToolAvailability('GET /apikeys/{}');
      expect(meta.documented).toBe(true);
      expect(meta.branch).toBe('46.0');
    });
  });
});
