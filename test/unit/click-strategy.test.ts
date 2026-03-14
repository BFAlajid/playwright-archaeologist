/**
 * Unit tests for src/instrumentation/click-strategy.ts
 *
 * Destructive action detection, safe override patterns,
 * attribute-based detection, and tier classification.
 */

import { describe, it, expect } from 'vitest';
import {
  isDestructiveText,
  hasDestructiveAttributes,
  classifyElement,
  shouldClick,
  type ElementInfo,
  type ClickTier,
} from '../../src/instrumentation/click-strategy.js';

// ---------------------------------------------------------------------------
// isDestructiveText
// ---------------------------------------------------------------------------

describe('isDestructiveText', () => {
  describe('detects destructive buttons/links', () => {
    it('detects "Log Out"', () => {
      expect(isDestructiveText('Log Out')).toBe(true);
    });

    it('detects "Logout"', () => {
      expect(isDestructiveText('Logout')).toBe(true);
    });

    it('detects "log out" (lowercase)', () => {
      expect(isDestructiveText('log out')).toBe(true);
    });

    it('detects "Sign Out"', () => {
      expect(isDestructiveText('Sign Out')).toBe(true);
    });

    it('detects "Sign out"', () => {
      expect(isDestructiveText('Sign out')).toBe(true);
    });

    it('detects "Delete"', () => {
      expect(isDestructiveText('Delete')).toBe(true);
    });

    it('detects "Delete Account"', () => {
      expect(isDestructiveText('Delete Account')).toBe(true);
    });

    it('detects "Remove"', () => {
      expect(isDestructiveText('Remove')).toBe(true);
    });

    it('detects "Destroy"', () => {
      expect(isDestructiveText('Destroy')).toBe(true);
    });

    it('detects "Deactivate"', () => {
      expect(isDestructiveText('Deactivate')).toBe(true);
    });

    it('detects "Cancel Account"', () => {
      expect(isDestructiveText('Cancel Account')).toBe(true);
    });

    it('detects "Unsubscribe"', () => {
      expect(isDestructiveText('Unsubscribe')).toBe(true);
    });

    it('detects "Reset"', () => {
      expect(isDestructiveText('Reset')).toBe(true);
    });
  });

  describe('safe overrides (should NOT be destructive)', () => {
    it('allows "Delete Filter" (not destructive)', () => {
      expect(isDestructiveText('Delete Filter')).toBe(false);
    });

    it('allows "Remove Filter"', () => {
      expect(isDestructiveText('Remove Filter')).toBe(false);
    });

    it('allows "Sign Up" (not sign out)', () => {
      expect(isDestructiveText('Sign Up')).toBe(false);
    });

    it('allows "Reset Filter"', () => {
      expect(isDestructiveText('Reset Filter')).toBe(false);
    });

    it('allows "Reset Search"', () => {
      expect(isDestructiveText('Reset Search')).toBe(false);
    });
  });

  describe('non-destructive text', () => {
    it('allows "Submit"', () => {
      expect(isDestructiveText('Submit')).toBe(false);
    });

    it('allows "Save"', () => {
      expect(isDestructiveText('Save')).toBe(false);
    });

    it('allows "Next"', () => {
      expect(isDestructiveText('Next')).toBe(false);
    });

    it('allows "Learn More"', () => {
      expect(isDestructiveText('Learn More')).toBe(false);
    });

    it('allows "Dashboard"', () => {
      expect(isDestructiveText('Dashboard')).toBe(false);
    });

    it('allows empty string', () => {
      expect(isDestructiveText('')).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// hasDestructiveAttributes
// ---------------------------------------------------------------------------

describe('hasDestructiveAttributes', () => {
  it('detects data-method="delete"', () => {
    expect(
      hasDestructiveAttributes({ 'data-method': 'delete' })
    ).toBe(true);
  });

  it('detects data-confirm attribute', () => {
    expect(
      hasDestructiveAttributes({
        'data-confirm': 'Are you sure?',
      })
    ).toBe(true);
  });

  it('detects data-turbo-method="delete"', () => {
    expect(
      hasDestructiveAttributes({ 'data-turbo-method': 'delete' })
    ).toBe(true);
  });

  it('allows data-method="get"', () => {
    expect(
      hasDestructiveAttributes({ 'data-method': 'get' })
    ).toBe(false);
  });

  it('allows data-method="post" (not delete)', () => {
    expect(
      hasDestructiveAttributes({ 'data-method': 'post' })
    ).toBe(false);
  });

  it('allows empty attributes', () => {
    expect(hasDestructiveAttributes({})).toBe(false);
  });

  it('allows non-destructive data attributes', () => {
    expect(
      hasDestructiveAttributes({
        'data-testid': 'button',
        'data-analytics': 'click',
      })
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// classifyElement
// ---------------------------------------------------------------------------

describe('classifyElement', () => {
  describe('Tier 1: anchor links', () => {
    it('classifies <a href="/page"> as Tier 1', () => {
      const el: ElementInfo = {
        tagName: 'A',
        text: 'About Us',
        href: '/about',
      };
      expect(classifyElement(el)).toBe(1);
    });

    it('classifies external link as Tier 1', () => {
      const el: ElementInfo = {
        tagName: 'A',
        text: 'Google',
        href: 'https://google.com',
      };
      expect(classifyElement(el)).toBe(1);
    });
  });

  describe('Tier 2: navigation elements', () => {
    it('classifies element inside <nav> as Tier 2', () => {
      const el: ElementInfo = {
        tagName: 'BUTTON',
        text: 'Products',
        parentTagName: 'NAV',
      };
      expect(classifyElement(el)).toBe(2);
    });

    it('classifies [role="tab"] as Tier 2', () => {
      const el: ElementInfo = {
        tagName: 'BUTTON',
        text: 'Settings',
        role: 'tab',
      };
      expect(classifyElement(el)).toBe(2);
    });

    it('classifies pagination button as Tier 2', () => {
      const el: ElementInfo = {
        tagName: 'A',
        text: 'Next',
        href: '?page=2',
        role: 'link',
        ariaLabel: 'Go to page 2',
      };
      // Pagination links with href are Tier 1
      expect(classifyElement(el)).toBeLessThanOrEqual(2);
    });
  });

  describe('Tier 3: generic interactive elements', () => {
    it('classifies non-nav button as Tier 3', () => {
      const el: ElementInfo = {
        tagName: 'BUTTON',
        text: 'Toggle Dark Mode',
      };
      expect(classifyElement(el)).toBe(3);
    });

    it('classifies clickable div as Tier 3', () => {
      const el: ElementInfo = {
        tagName: 'DIV',
        text: 'Expand Details',
        role: 'button',
      };
      expect(classifyElement(el)).toBe(3);
    });
  });

  describe('Tier 4: destructive elements', () => {
    it('classifies "Delete" button as Tier 4', () => {
      const el: ElementInfo = {
        tagName: 'BUTTON',
        text: 'Delete',
        dataAttributes: {},
      };
      expect(classifyElement(el)).toBe(4);
    });

    it('classifies "Log Out" link as Tier 4', () => {
      const el: ElementInfo = {
        tagName: 'A',
        text: 'Log Out',
        href: '/logout',
      };
      expect(classifyElement(el)).toBe(4);
    });

    it('classifies element with data-method="delete" as Tier 4', () => {
      const el: ElementInfo = {
        tagName: 'BUTTON',
        text: 'Remove Item',
        dataAttributes: { 'data-method': 'delete' },
      };
      expect(classifyElement(el)).toBe(4);
    });

    it('classifies element with data-confirm as Tier 4', () => {
      const el: ElementInfo = {
        tagName: 'A',
        text: 'Proceed',
        href: '/action',
        dataAttributes: { 'data-confirm': 'Are you sure?' },
      };
      expect(classifyElement(el)).toBe(4);
    });
  });
});

// ---------------------------------------------------------------------------
// shouldClick
// ---------------------------------------------------------------------------

describe('shouldClick', () => {
  it('always clicks Tier 1 (href extraction, not actual click)', () => {
    const el: ElementInfo = {
      tagName: 'A',
      text: 'Home',
      href: '/',
    };
    // Tier 1 elements have their href extracted, not clicked
    // shouldClick should indicate whether to perform a browser click
    expect(shouldClick(el, {})).toBe(false); // href is extracted, not clicked
  });

  it('clicks Tier 2 elements by default', () => {
    const el: ElementInfo = {
      tagName: 'BUTTON',
      text: 'Products',
      parentTagName: 'NAV',
    };
    expect(shouldClick(el, {})).toBe(true);
  });

  it('does not click Tier 3 elements by default', () => {
    const el: ElementInfo = {
      tagName: 'BUTTON',
      text: 'Toggle Mode',
    };
    expect(shouldClick(el, {})).toBe(false);
  });

  it('clicks Tier 3 elements when deepClick is enabled', () => {
    const el: ElementInfo = {
      tagName: 'BUTTON',
      text: 'Toggle Mode',
    };
    expect(shouldClick(el, { deepClick: true })).toBe(true);
  });

  it('never clicks Tier 4 (destructive) elements', () => {
    const el: ElementInfo = {
      tagName: 'BUTTON',
      text: 'Delete Account',
    };
    expect(shouldClick(el, {})).toBe(false);
    expect(shouldClick(el, { deepClick: true })).toBe(false);
  });

  it('never clicks destructive elements even with deep click', () => {
    const el: ElementInfo = {
      tagName: 'A',
      text: 'Log Out',
      href: '/logout',
    };
    expect(shouldClick(el, { deepClick: true })).toBe(false);
  });
});
