import { describe, it, expect } from 'vitest';
import {
  computeWaterBill,
  allocateTiers,
  getCurrentWaterTierRate,
  gallonsToHcf,
  hcfToGallons,
  GALLONS_PER_HCF,
} from '../ladwpWater.js';

describe('ladwpWater tiered commodity engine', () => {
  it('reproduces the Aug 2026 bill: 217 HCF → $3,179.32 water commodity', () => {
    const bill = computeWaterBill(217, 58, { includeSewer: false });
    expect(bill.commoditySubtotal).toBeCloseTo(3179.32, 2);
  });

  it('allocates 217 HCF across all four current tiers correctly', () => {
    const tiers = allocateTiers(217);
    expect(tiers.map(t => t.hcf)).toEqual([16, 62, 124, 15]);
    expect(tiers[0].cost).toBeCloseTo(16 * 11.89, 2);
    expect(tiers[1].cost).toBeCloseTo(62 * 14.33355, 2);
    expect(tiers[2].cost).toBeCloseTo(124 * 15.07952, 2);
    expect(tiers[3].cost).toBeCloseTo(15 * 15.36933, 2);
  });

  it('keeps low usage entirely in Tier 1', () => {
    const tiers = allocateTiers(10);
    expect(tiers[0].hcf).toBe(10);
    expect(tiers[1].hcf).toBe(0);
    expect(tiers[2].hcf).toBe(0);
    expect(tiers[3].hcf).toBe(0);
  });

  it('marginal rate reflects the tier the next unit falls into', () => {
    expect(getCurrentWaterTierRate(0).tier).toBe(1);
    expect(getCurrentWaterTierRate(16).tier).toBe(2);   // just past tier 1
    expect(getCurrentWaterTierRate(78).tier).toBe(3);   // just past tier 2
    expect(getCurrentWaterTierRate(202).tier).toBe(4);  // just past tier 3
    expect(getCurrentWaterTierRate(200).tier).toBe(3);

    const t4 = getCurrentWaterTierRate(217);
    expect(t4.ratePerHcf).toBeCloseTo(15.36933, 5);
    expect(t4.ratePerGallon).toBeCloseTo(15.36933 / GALLONS_PER_HCF, 6);
    expect(t4.nextTierAtHcf).toBeNull();
  });

  it('adds a sewer charge on top of the commodity when included', () => {
    const noSewer = computeWaterBill(112, 61, { includeSewer: false });
    const withSewer = computeWaterBill(112, 61, { includeSewer: true });
    expect(withSewer.sewerCharge).toBeGreaterThan(0);
    expect(withSewer.totalWaterCharges).toBeCloseTo(noSewer.commoditySubtotal + withSewer.sewerCharge, 2);
  });

  it('computes per-gallon effective cost and unit conversions', () => {
    const bill = computeWaterBill(112, 61, { includeSewer: false });
    expect(bill.totalGallons).toBe(112 * GALLONS_PER_HCF);
    expect(bill.effectivePerGallon).toBeGreaterThan(0);
    expect(gallonsToHcf(748)).toBeCloseTo(1, 5);
    expect(hcfToGallons(1)).toBeCloseTo(748, 2);
  });

  it('handles zero usage without dividing by zero', () => {
    const bill = computeWaterBill(0, 61, { includeSewer: false });
    expect(bill.commoditySubtotal).toBe(0);
    expect(bill.effectivePerGallon).toBe(0);
    expect(bill.effectivePerHcf).toBe(0);
  });
});
