/// <reference lib="dom" />

/**
 * FormProber collector — extracts form metadata from a page.
 *
 * Receives a Playwright Page that has already navigated to the target URL.
 * Does NOT submit forms or trigger validation — it only reads the current DOM state.
 *
 * Extracts:
 *   - Explicit <form> elements with all fields, options, and attributes
 *   - Implicit forms (orphaned input groups outside any <form> wrapper)
 *   - Submit button text
 *   - Field labels, validation attributes, and default values
 *   - Password field values are redacted
 *
 * Performance: all form extraction (explicit + implicit) runs in a SINGLE
 * page.evaluate roundtrip. Previously the collector took N+1 IPC round-trips
 * per page (one per <form>). A page with many forms pays a measurable cost
 * for each round-trip.
 */

import type { Page } from 'playwright';
import type {
  FormProbeResult,
  FormInfo,
  FormField,
  FormFieldOption,
} from '../types/artifacts.js';

// ---------------------------------------------------------------------------
// Types for the raw data returned by page.evaluate
// ---------------------------------------------------------------------------

interface RawFormData {
  action: string;
  method: string;
  id: string | null;
  name: string | null;
  enctype: string | null;
  ariaLabel: string | null;
  fields: RawFieldData[];
  submitButtonText: string | null;
  isImplicit: boolean;
}

interface RawFieldData {
  name: string;
  type: string;
  required: boolean;
  pattern: string | null;
  placeholder: string | null;
  label: string | null;
  options: FormFieldOption[] | null;
  min: string | null;
  max: string | null;
  step: string | null;
  maxLength: number | null;
  multiple: boolean;
  accept: string | null;
  defaultValue: string | null;
  isPassword: boolean;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Probe all forms on the page and extract their metadata.
 *
 * Executes a single in-browser pass that collects both explicit `<form>`
 * elements and orphaned input groups ("implicit" forms).
 *
 * @param page     Playwright Page already navigated to the target URL.
 * @param pageUrl  The URL of the page being probed.
 */
export async function probeForms(
  page: Page,
  pageUrl: string,
): Promise<FormProbeResult> {
  let rawForms: RawFormData[];
  try {
    rawForms = await page.evaluate(extractAllFormsInBrowser, pageUrl);
  } catch {
    // Graceful degradation: return an empty list rather than throw.
    rawForms = [];
  }

  const forms: FormInfo[] = rawForms.map((raw) =>
    convertRawFormToFormInfo(raw, raw.isImplicit),
  );

  return {
    pageUrl,
    forms,
  };
}

// ---------------------------------------------------------------------------
// In-browser extractor. Runs in the Playwright page context — keep it
// self-contained (no closures over module-scope data, no imports).
// ---------------------------------------------------------------------------

function extractAllFormsInBrowser(currentPageUrl: string): RawFormData[] {
  // -----------------------------------------------------------------------
  // Shared helpers (declared first so both explicit and implicit passes
  // can call them without duplication).
  // -----------------------------------------------------------------------

  function deriveLabel(element: Element): string | null {
    // 1. aria-label
    const ariaLbl = element.getAttribute('aria-label');
    if (ariaLbl) return ariaLbl;

    // 2. aria-labelledby
    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy) {
      const labelEl = document.getElementById(labelledBy);
      if (labelEl) {
        const text = labelEl.textContent?.trim();
        if (text) return text;
      }
    }

    // 3. Associated <label for="id">
    const elId = element.getAttribute('id');
    if (elId) {
      const labelEl = document.querySelector<HTMLLabelElement>(
        `label[for="${CSS.escape(elId)}"]`,
      );
      if (labelEl) {
        const text = labelEl.textContent?.trim();
        if (text) return text;
      }
    }

    // 4. Wrapping <label>
    const parentLabel = element.closest('label');
    if (parentLabel) {
      const text = parentLabel.textContent?.trim();
      if (text) return text;
    }

    return null;
  }

  /**
   * Extract a RawFieldData from a single input/select/textarea element.
   * Does NOT handle radio/checkbox groups — callers handle those at the
   * group level so all options are collapsed into one field entry.
   */
  function extractField(el: Element): RawFieldData {
    const tagName = el.tagName.toLowerCase();
    const fieldName = el.getAttribute('name') ?? '';
    let fieldType: string;

    if (tagName === 'select') {
      fieldType = 'select';
    } else if (tagName === 'textarea') {
      fieldType = 'textarea';
    } else {
      fieldType = (el as HTMLInputElement).type ?? 'text';
    }

    const required =
      (el as HTMLInputElement).required ||
      el.getAttribute('aria-required') === 'true';
    const pattern = el.getAttribute('pattern');
    const placeholder = el.getAttribute('placeholder');
    const label = deriveLabel(el);

    let options: FormFieldOption[] | null = null;
    if (tagName === 'select') {
      const selectEl = el as HTMLSelectElement;
      options = [];
      selectEl.querySelectorAll('option').forEach((opt) => {
        options!.push({
          value: opt.value,
          label: opt.textContent?.trim() ?? opt.value,
          selected: opt.selected,
        });
      });
    }

    const min = el.getAttribute('min');
    const max = el.getAttribute('max');
    const step = el.getAttribute('step');

    const maxLengthAttr = el.getAttribute('maxlength');
    const maxLength = maxLengthAttr !== null ? parseInt(maxLengthAttr, 10) : null;

    const multiple =
      (el as HTMLInputElement).multiple ||
      (el as HTMLSelectElement).multiple ||
      false;

    const accept = el.getAttribute('accept');

    const isPassword = fieldType === 'password';
    let defaultValue: string | null = null;
    if (tagName === 'textarea') {
      defaultValue = (el as HTMLTextAreaElement).value || null;
    } else if (tagName === 'select') {
      const selectedOpt = (el as HTMLSelectElement).selectedOptions[0];
      defaultValue = selectedOpt?.value ?? null;
    } else {
      defaultValue = (el as HTMLInputElement).value || null;
    }

    return {
      name: fieldName,
      type: fieldType,
      required,
      pattern,
      placeholder,
      label,
      options,
      min,
      max,
      step,
      maxLength: maxLength !== null && !isNaN(maxLength) ? maxLength : null,
      multiple,
      accept,
      defaultValue,
      isPassword,
    };
  }

  /**
   * Extract all fields from a <form>, collapsing radio/checkbox groups.
   */
  function extractFormFields(formEl: HTMLFormElement): RawFieldData[] {
    const fieldEls = formEl.querySelectorAll('input, select, textarea');
    const fields: RawFieldData[] = [];
    const processedRadioGroups = new Set<string>();

    fieldEls.forEach((el) => {
      const tagName = el.tagName.toLowerCase();
      const fieldName = el.getAttribute('name') ?? '';
      const fieldType =
        tagName === 'select'
          ? 'select'
          : tagName === 'textarea'
            ? 'textarea'
            : (el as HTMLInputElement).type ?? 'text';

      if ((fieldType === 'radio' || fieldType === 'checkbox') && fieldName) {
        if (processedRadioGroups.has(fieldName)) return;
        processedRadioGroups.add(fieldName);

        const groupEls = formEl.querySelectorAll(
          `input[name="${CSS.escape(fieldName)}"]`,
        );
        const options: FormFieldOption[] = [];
        groupEls.forEach((groupEl) => {
          const inp = groupEl as HTMLInputElement;
          const groupLabel = deriveLabel(groupEl);
          options.push({
            value: inp.value ?? '',
            label: groupLabel ?? inp.value ?? '',
            selected: inp.checked,
          });
        });

        const firstEl = groupEls[0] as HTMLInputElement;
        fields.push({
          name: fieldName,
          type: fieldType,
          required:
            firstEl.required ||
            firstEl.getAttribute('aria-required') === 'true',
          pattern: null,
          placeholder: null,
          label: deriveLabel(firstEl),
          options,
          min: null,
          max: null,
          step: null,
          maxLength: null,
          multiple: false,
          accept: null,
          defaultValue: null,
          isPassword: false,
        });
        return;
      }

      if (fieldType === 'radio' || fieldType === 'checkbox') {
        // Nameless radio/checkbox — skip; browsers don't submit these.
        if (fieldName && processedRadioGroups.has(fieldName)) return;
      }

      fields.push(extractField(el));
    });

    return fields;
  }

  // -----------------------------------------------------------------------
  // Pass 1: explicit <form> elements
  // -----------------------------------------------------------------------

  const out: RawFormData[] = [];
  const formEls = document.querySelectorAll('form');

  formEls.forEach((formEl) => {
    const form = formEl as HTMLFormElement;

    const rawAction = form.getAttribute('action');
    let action = '';
    if (rawAction !== null && rawAction !== '') {
      try {
        action = new URL(rawAction, currentPageUrl).href;
      } catch {
        action = rawAction;
      }
    }

    const method = (form.getAttribute('method') ?? 'GET').toUpperCase();

    // Submit button
    let submitButtonText: string | null = null;
    const submitBtn =
      form.querySelector<HTMLButtonElement>('button[type="submit"]') ??
      form.querySelector<HTMLInputElement>('input[type="submit"]');
    if (submitBtn) {
      if (submitBtn.tagName.toLowerCase() === 'input') {
        submitButtonText = (submitBtn as HTMLInputElement).value || null;
      } else {
        submitButtonText = submitBtn.textContent?.trim() || null;
      }
    } else {
      const firstButton = form.querySelector<HTMLButtonElement>('button');
      if (firstButton) {
        submitButtonText = firstButton.textContent?.trim() || null;
      }
    }

    out.push({
      action,
      method,
      id: form.getAttribute('id'),
      name: form.getAttribute('name'),
      enctype: form.getAttribute('enctype'),
      ariaLabel: form.getAttribute('aria-label'),
      fields: extractFormFields(form),
      submitButtonText,
      isImplicit: false,
    });
  });

  // -----------------------------------------------------------------------
  // Pass 2: implicit/orphaned input groups
  // -----------------------------------------------------------------------

  const allFields = document.querySelectorAll('input, select, textarea');
  const orphanedFields: Element[] = [];
  allFields.forEach((field) => {
    if (!field.closest('form')) {
      const tagName = field.tagName.toLowerCase();
      const type = (field as HTMLInputElement).type;
      if (
        tagName === 'input' &&
        (type === 'hidden' || type === 'submit' || type === 'button')
      ) {
        return;
      }
      orphanedFields.push(field);
    }
  });

  if (orphanedFields.length > 0) {
    const fields: RawFieldData[] = orphanedFields.map((el) => extractField(el));

    let submitButtonText: string | null = null;
    const submitBtns = document.querySelectorAll(
      'button[type="submit"], input[type="submit"]',
    );
    submitBtns.forEach((btn) => {
      if (!btn.closest('form') && !submitButtonText) {
        if (btn.tagName.toLowerCase() === 'input') {
          submitButtonText = (btn as HTMLInputElement).value || null;
        } else {
          submitButtonText = btn.textContent?.trim() || null;
        }
      }
    });

    out.push({
      action: '',
      method: 'GET',
      id: null,
      name: null,
      enctype: null,
      ariaLabel: null,
      fields,
      submitButtonText,
      isImplicit: true,
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Internal helpers (Node side)
// ---------------------------------------------------------------------------

/**
 * Convert raw form data from page.evaluate into a FormInfo object.
 * Strips null values into undefined and redacts password defaults.
 */
function convertRawFormToFormInfo(
  raw: RawFormData,
  isImplicit: boolean,
): FormInfo {
  const fields: FormField[] = raw.fields.map((f) => {
    const field: FormField = {
      name: f.name,
      type: f.type,
      required: f.required,
    };

    if (f.pattern != null) field.pattern = f.pattern;
    if (f.placeholder != null) field.placeholder = f.placeholder;
    if (f.label != null) field.label = f.label;
    if (f.options != null) field.options = f.options;
    if (f.min != null) field.min = f.min;
    if (f.max != null) field.max = f.max;
    if (f.step != null) field.step = f.step;
    if (f.maxLength != null) field.maxLength = f.maxLength;
    if (f.multiple) field.multiple = f.multiple;
    if (f.accept != null) field.accept = f.accept;

    // Redact password field default values
    if (f.isPassword && f.defaultValue != null) {
      field.defaultValue = '[REDACTED]';
    } else if (f.defaultValue != null) {
      field.defaultValue = f.defaultValue;
    }

    return field;
  });

  const formInfo: FormInfo = {
    action: raw.action,
    method: raw.method,
    isImplicit,
    fields,
    validationMessages: [],
    wasHidden: false,
  };

  if (raw.id != null) formInfo.id = raw.id;
  if (raw.name != null) formInfo.name = raw.name;
  if (raw.submitButtonText != null) formInfo.submitButtonText = raw.submitButtonText;
  if (raw.enctype != null) formInfo.enctype = raw.enctype;
  if (raw.ariaLabel != null) formInfo.ariaLabel = raw.ariaLabel;

  return formInfo;
}
