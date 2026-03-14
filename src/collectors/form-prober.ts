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
 */

import type { Page } from 'playwright';
import type {
  FormProbeResult,
  FormInfo,
  FormField,
  FormFieldOption,
} from '../types/artifacts.js';

// ---------------------------------------------------------------------------
// Types for the raw data returned by page.evaluate inside a form context
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
 * @param page     Playwright Page already navigated to the target URL.
 * @param pageUrl  The URL of the page being probed.
 */
export async function probeForms(
  page: Page,
  pageUrl: string,
): Promise<FormProbeResult> {
  const forms: FormInfo[] = [];

  // 1. Extract explicit <form> elements using locators
  const formLocators = await page.locator('form').all();

  for (const formLocator of formLocators) {
    try {
      const rawForm = await formLocator.evaluate(
        (formEl: HTMLFormElement, currentPageUrl: string): RawFormData => {
          // --- Form-level attributes ---
          const rawAction = formEl.getAttribute('action');
          let action = '';
          if (rawAction !== null && rawAction !== '') {
            // Resolve relative action URLs to absolute using the browser's URL resolution
            try {
              action = new URL(rawAction, currentPageUrl).href;
            } catch {
              action = rawAction;
            }
          }

          const method = (formEl.getAttribute('method') ?? 'GET').toUpperCase();
          const id = formEl.getAttribute('id');
          const name = formEl.getAttribute('name');
          const enctype = formEl.getAttribute('enctype');
          const ariaLabel = formEl.getAttribute('aria-label');

          // --- Fields ---
          const fieldEls = formEl.querySelectorAll('input, select, textarea');
          const fields: RawFieldData[] = [];
          const processedRadioGroups = new Set<string>();

          fieldEls.forEach((el) => {
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

            // For radio/checkbox groups, collect all options under the same name
            if ((fieldType === 'radio' || fieldType === 'checkbox') && fieldName) {
              if (processedRadioGroups.has(fieldName)) return;
              processedRadioGroups.add(fieldName);

              const groupEls = formEl.querySelectorAll(
                `input[name="${CSS.escape(fieldName)}"]`,
              );
              const options: FormFieldOption[] = [];
              groupEls.forEach((groupEl) => {
                const inp = groupEl as HTMLInputElement;
                // Derive label from associated label element or adjacent text
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

            // Skip individual radio/checkbox elements that belong to a group
            // (they are handled above)
            if (fieldType === 'radio' || fieldType === 'checkbox') {
              // standalone radio/checkbox without a name — treat as individual field
              if (fieldName && processedRadioGroups.has(fieldName)) return;
            }

            // Regular field extraction
            const required =
              (el as HTMLInputElement).required ||
              el.getAttribute('aria-required') === 'true';
            const pattern = el.getAttribute('pattern');
            const placeholder = el.getAttribute('placeholder');
            const label = deriveLabel(el);

            // Select options
            let options: FormFieldOption[] | null = null;
            if (tagName === 'select') {
              const selectEl = el as HTMLSelectElement;
              options = [];
              const optionEls = selectEl.querySelectorAll('option');
              optionEls.forEach((opt) => {
                options!.push({
                  value: opt.value,
                  label: opt.textContent?.trim() ?? opt.value,
                  selected: opt.selected,
                });
              });
            }

            // Numeric attributes
            const min = el.getAttribute('min');
            const max = el.getAttribute('max');
            const step = el.getAttribute('step');

            // MaxLength
            const maxLengthAttr = el.getAttribute('maxlength');
            const maxLength =
              maxLengthAttr !== null ? parseInt(maxLengthAttr, 10) : null;

            // Multiple
            const multiple =
              (el as HTMLInputElement).multiple ||
              (el as HTMLSelectElement).multiple ||
              false;

            // Accept (file inputs)
            const accept = el.getAttribute('accept');

            // Default value
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

            fields.push({
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
            });
          });

          // --- Submit button ---
          let submitButtonText: string | null = null;
          const submitBtn =
            formEl.querySelector<HTMLButtonElement>('button[type="submit"]') ??
            formEl.querySelector<HTMLInputElement>('input[type="submit"]');
          if (submitBtn) {
            if (submitBtn.tagName.toLowerCase() === 'input') {
              submitButtonText = (submitBtn as HTMLInputElement).value || null;
            } else {
              submitButtonText = submitBtn.textContent?.trim() || null;
            }
          } else {
            // Fall back to first button inside the form
            const firstButton =
              formEl.querySelector<HTMLButtonElement>('button');
            if (firstButton) {
              submitButtonText = firstButton.textContent?.trim() || null;
            }
          }

          return {
            action,
            method,
            id,
            name,
            enctype,
            ariaLabel,
            fields,
            submitButtonText,
          };

          // --- Helper: derive label for a form element ---
          function deriveLabel(element: Element): string | null {
            // 1. Check aria-label
            const ariaLbl = element.getAttribute('aria-label');
            if (ariaLbl) return ariaLbl;

            // 2. Check aria-labelledby
            const labelledBy = element.getAttribute('aria-labelledby');
            if (labelledBy) {
              const labelEl = document.getElementById(labelledBy);
              if (labelEl) {
                const text = labelEl.textContent?.trim();
                if (text) return text;
              }
            }

            // 3. Check for associated <label> element
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

            // 4. Check for wrapping <label> element
            const parentLabel = element.closest('label');
            if (parentLabel) {
              const text = parentLabel.textContent?.trim();
              if (text) return text;
            }

            return null;
          }
        },
        pageUrl,
      );

      forms.push(convertRawFormToFormInfo(rawForm, false));
    } catch {
      // If extracting a single form fails, skip it (graceful degradation)
      continue;
    }
  }

  // 2. Detect implicit forms (orphaned inputs outside any <form> wrapper)
  try {
    const implicitForms = await page.evaluate(
      (currentPageUrl: string): RawFormData[] => {
        // Find all inputs/selects/textareas not inside a <form>
        const allFields = document.querySelectorAll(
          'input, select, textarea',
        );
        const orphanedFields: Element[] = [];

        allFields.forEach((field) => {
          if (!field.closest('form')) {
            // Exclude hidden inputs and submit/button types
            const tagName = field.tagName.toLowerCase();
            const type = (field as HTMLInputElement).type;
            if (tagName === 'input' && (type === 'hidden' || type === 'submit' || type === 'button')) {
              return;
            }
            orphanedFields.push(field);
          }
        });

        if (orphanedFields.length === 0) return [];

        // Group orphaned fields — treat all orphaned fields as one implicit form
        const fields: RawFieldData[] = orphanedFields.map((el) => {
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

          // Select options
          let options: FormFieldOption[] | null = null;
          if (tagName === 'select') {
            options = [];
            const optionEls = (el as HTMLSelectElement).querySelectorAll('option');
            optionEls.forEach((opt) => {
              options!.push({
                value: opt.value,
                label: opt.textContent?.trim() ?? opt.value,
                selected: opt.selected,
              });
            });
          }

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

          // Derive label
          let label: string | null = null;
          const ariaLbl = el.getAttribute('aria-label');
          if (ariaLbl) {
            label = ariaLbl;
          } else {
            const elId = el.getAttribute('id');
            if (elId) {
              const labelEl = document.querySelector<HTMLLabelElement>(
                `label[for="${CSS.escape(elId)}"]`,
              );
              if (labelEl) {
                label = labelEl.textContent?.trim() ?? null;
              }
            }
            if (!label) {
              const parentLabel = el.closest('label');
              if (parentLabel) {
                label = parentLabel.textContent?.trim() ?? null;
              }
            }
          }

          return {
            name: fieldName,
            type: fieldType,
            required,
            pattern: el.getAttribute('pattern'),
            placeholder: el.getAttribute('placeholder'),
            label,
            options,
            min: el.getAttribute('min'),
            max: el.getAttribute('max'),
            step: el.getAttribute('step'),
            maxLength: el.getAttribute('maxlength')
              ? parseInt(el.getAttribute('maxlength')!, 10)
              : null,
            multiple: (el as HTMLInputElement).multiple || false,
            accept: el.getAttribute('accept'),
            defaultValue,
            isPassword,
          };
        });

        // Look for a submit button near the orphaned fields
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

        return [
          {
            action: '',
            method: 'GET',
            id: null,
            name: null,
            enctype: null,
            ariaLabel: null,
            fields,
            submitButtonText,
          },
        ];
      },
      pageUrl,
    );

    for (const rawForm of implicitForms) {
      forms.push(convertRawFormToFormInfo(rawForm, true));
    }
  } catch {
    // If implicit form detection fails, skip it (graceful degradation)
  }

  return {
    pageUrl,
    forms,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
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
