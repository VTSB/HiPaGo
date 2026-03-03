<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-02-23 | Updated: 2026-02-23 -->

# HiPaGo/src/test Directory Guide

## Purpose

The `test/` directory contains test configuration and setup utilities for the HiPaGo test suite. It configures Vitest/Jest to work with React components, TypeScript, and DOM testing libraries.

## Key Files

- **`setup.ts`** - Test environment initialization and global configuration

## File Overview

### `setup.ts` (43 bytes)

**Content**
```typescript
import '@testing-library/jest-dom/vitest';
```

**Purpose**
- Imports Jest DOM matchers from `@testing-library/jest-dom`
- Makes custom matchers available in all test files without explicit imports
- Examples: `toBeInTheDocument()`, `toBeVisible()`, `toHaveClass()`, etc.

**Vitest Configuration**
This file is referenced in `vitest.config.ts` via:
```typescript
{
  test: {
    setupFiles: ['src/test/setup.ts'],
    // ... other config
  }
}
```

**How It Works**
1. Vitest loads `setup.ts` before running any tests
2. The import statement registers Jest DOM matchers globally
3. Test files can now use matchers like:
   ```typescript
   expect(element).toBeInTheDocument();
   expect(button).toBeDisabled();
   ```

## Jest DOM Matchers Available

After importing, these matchers are available in all tests:

### Element Presence
- `toBeInTheDocument()` — element exists in DOM
- `toBeVisible()` — element is visible and not hidden
- `toBeEmptyDOMElement()` — element has no child nodes

### Attributes & Properties
- `toHaveAttribute(attr, value?)` — element has attribute (optionally with value)
- `toHaveClass(className)` — element has CSS class
- `toHaveStyle(styles)` — element has inline styles
- `toHaveTextContent(text)` — element contains text
- `toHaveFormValues(values)` — form has expected values

### User Interaction
- `toBeDisabled()` — input/button is disabled
- `toBeEnabled()` — input/button is enabled
- `toBeChecked()` — checkbox/radio is checked
- `toHaveFocus()` — element has focus
- `toHaveValue(value)` — input has value

### Styling & Visibility
- `toBePartiallyChecked()` — checkbox is partially checked
- `toHaveDisplayValue(value)` — select/input has display value
- `toHaveErrorMessage(message)` — element has aria-invalid with message

## Integration with Test Structure

### Expected Test File Structure
```typescript
// src/features/[feature]/__tests__/[component].test.tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MyComponent } from '../MyComponent';

describe('MyComponent', () => {
  it('should render button', () => {
    render(<MyComponent />);
    expect(screen.getByRole('button')).toBeInTheDocument();
  });

  it('should disable button when loading', () => {
    render(<MyComponent isLoading />);
    expect(screen.getByRole('button')).toBeDisabled();
  });
});
```

### Common Test Utilities

**Queries** (from `@testing-library/react`)
```typescript
// By role (preferred for accessibility)
screen.getByRole('button', { name: /submit/i });
screen.getByRole('textbox', { name: /email/i });

// By label (works for form inputs)
screen.getByLabelText('Email');

// By placeholder
screen.getByPlaceholderText('Enter email');

// By text (for non-form elements)
screen.getByText(/submit/i);

// By test ID (last resort)
screen.getByTestId('submit-button');
```

**User Interaction** (from `@testing-library/user-event`)
```typescript
import userEvent from '@testing-library/user-event';

const user = await userEvent.setup();
await user.click(button);
await user.type(input, 'text');
await user.selectOptions(select, 'option-value');
```

**Assertions**
```typescript
// With Jest DOM matchers
expect(element).toBeInTheDocument();
expect(input).toHaveValue('expected value');
expect(button).toHaveClass('active');
expect(checkbox).toBeChecked();

// Standard Jest assertions
expect(value).toBe(expected);
expect(array).toHaveLength(3);
expect(spy).toHaveBeenCalledWith(arg);
```

## Test Setup and Configuration

### Vitest Config Location
- File: `vitest.config.ts` (at project root)
- Must reference: `setupFiles: ['src/test/setup.ts']`

### Package Dependencies Required
```json
{
  "devDependencies": {
    "@testing-library/react": "^14+",
    "@testing-library/jest-dom": "^6+",
    "@testing-library/user-event": "^14+",
    "vitest": "^1+",
    "@vitest/ui": "^1+",
    "happy-dom": "^12+" // DOM environment
  }
}
```

### Environment Variables in Tests
- Vitest runs with `NODE_ENV='test'`
- Mock environment variables as needed:
  ```typescript
  beforeEach(() => {
    process.env.NEXT_PUBLIC_API_URL = 'http://localhost:3000';
  });
  ```

## For AI Agents

### Common Tasks

**Add new test file:**
1. Create file: `src/features/[feature]/__tests__/[component].test.tsx`
2. Import testing utilities:
   ```typescript
   import { render, screen } from '@testing-library/react';
   import userEvent from '@testing-library/user-event';
   ```
3. Write test suite with `describe` and `it` blocks
4. Use queries to find elements by role (most accessible)
5. Use Jest DOM matchers for assertions

**Test a React component:**
1. Use `render()` to render component
2. Use `screen.getByRole()` to find interactive elements
3. Use `userEvent` to simulate user actions
4. Use Jest DOM matchers to assert results:
   ```typescript
   it('should update input on type', async () => {
     const user = await userEvent.setup();
     render(<InputComponent />);
     const input = screen.getByRole('textbox');
     await user.type(input, 'hello');
     expect(input).toHaveValue('hello');
   });
   ```

**Test component with props:**
1. Render component with test props
2. Assert DOM reflects prop values
3. Test prop changes via re-render:
   ```typescript
   const { rerender } = render(<Component disabled={false} />);
   expect(button).not.toBeDisabled();
   rerender(<Component disabled={true} />);
   expect(button).toBeDisabled();
   ```

**Test async behavior:**
1. Use `waitFor()` to wait for async updates:
   ```typescript
   import { render, screen, waitFor } from '@testing-library/react';

   it('should load data', async () => {
     render(<DataComponent />);
     await waitFor(() => {
       expect(screen.getByText('Loaded')).toBeInTheDocument();
     });
   });
   ```

**Mock external dependencies:**
1. Mock API calls:
   ```typescript
   vi.mock('@/lib/api/gallery', () => ({
     getGalleryById: vi.fn(() => Promise.resolve({ id: 1, title: 'Test' }))
   }));
   ```
2. Mock Zustand store:
   ```typescript
   import { useSettingsStore } from '@/lib/store/settings';
   vi.mock('@/lib/store/settings', () => ({
     useSettingsStore: vi.fn((selector) => {
       return selector({ language: 'english' });
     })
   }));
   ```

**Run tests:**
```bash
pnpm test                    # Run all tests
pnpm test --ui              # Open UI dashboard
pnpm test src/features      # Run tests in directory
pnpm test --watch           # Watch mode
pnpm test Component.test     # Run specific file
```

### Testing Patterns

**Client Component Testing**
```typescript
// Component is 'use client'
import { render, screen } from '@testing-library/react';
import { MyClientComponent } from './MyClientComponent';

it('should render client component', () => {
  render(<MyClientComponent />);
  expect(screen.getByText('Hello')).toBeInTheDocument();
});
```

**Component with Hooks**
```typescript
// Component uses useState, useEffect
it('should update state on interaction', async () => {
  const user = await userEvent.setup();
  render(<StatefulComponent />);

  const button = screen.getByRole('button');
  await user.click(button);

  expect(screen.getByText('Clicked')).toBeInTheDocument();
});
```

**Component with Store**
```typescript
// Component uses Zustand store
vi.mock('@/lib/store/settings');
it('should read from store', () => {
  render(<ComponentThatUsesStore />);
  // assertion based on mock store value
});
```

### Accessibility Testing

Use `@testing-library/jest-dom` matchers to improve accessibility:
```typescript
// Good: query by role
screen.getByRole('button', { name: /submit/i });

// Good: query by label
screen.getByLabelText('Email');

// Avoid: query by CSS class or test ID (breaks with refactoring)
screen.getByTestId('submit-button');
```

### Performance Testing

For component performance tests, use Vitest's benchmark feature:
```typescript
import { bench } from 'vitest';

bench('render gallery grid', () => {
  render(<GalleryGrid items={items} />);
});
```

### Debugging Tests

```typescript
// Print DOM to console
import { render, screen } from '@testing-library/react';
const { debug } = render(<Component />);
debug(); // prints entire DOM

// Print specific element
screen.debug(screen.getByRole('button'));

// Use testing-library screen queries
screen.logTestingPlaygroundURL(); // generates selector helper
```

## Troubleshooting

**"toBeInTheDocument is not a function"**
- Verify `setup.ts` imports `@testing-library/jest-dom/vitest`
- Check `vitest.config.ts` references `setupFiles: ['src/test/setup.ts']`
- Restart test runner

**"render is not exported from @testing-library/react"**
- Ensure `@testing-library/react` is installed: `pnpm add -D @testing-library/react`

**Tests timeout waiting for async**
- Use `waitFor()` with timeout: `waitFor(() => {...}, { timeout: 5000 })`
- Check Promise resolution in component

**DOM not updating after user action**
- Ensure using `userEvent` (not `fireEvent`)
- Use `await` with user events
- Wrap in `waitFor()` if async state update

<!-- MANUAL: -->
