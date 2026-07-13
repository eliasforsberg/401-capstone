/**
 * CSV export utilities for reports.
 *
 * Uses expo-file-system to write a temp file and expo-sharing to share it.
 * Falls back to console.log when running in an environment where the file
 * system or sharing APIs are unavailable (e.g., simulator without share sheet).
 *
 * Requirements: 10.6
 */

import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Escape a single CSV field value.
 * Per RFC 4180: if the field contains a comma, double-quote, or newline it
 * must be wrapped in double-quotes, and any existing double-quotes must be
 * doubled.
 */
function escapeField(value: string): string {
  if (value.includes('"') || value.includes(',') || value.includes('\n') || value.includes('\r')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Convert a headers array and rows matrix into a valid CSV string (CRLF line
 * endings per RFC 4180).
 */
function buildCsvContent(headers: string[], rows: string[][]): string {
  const lines: string[] = [];

  // Header row
  lines.push(headers.map(escapeField).join(','));

  // Data rows
  for (const row of rows) {
    lines.push(row.map(escapeField).join(','));
  }

  return lines.join('\r\n');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Export tabular data as a CSV file and trigger the native share sheet.
 *
 * @param headers  Column header labels
 * @param rows     Array of string rows; each row must have the same length as
 *                 `headers`
 * @param filename Suggested filename (without extension — `.csv` will be
 *                 appended automatically if missing)
 */
export async function exportToCSV(
  headers: string[],
  rows: string[][],
  filename: string,
): Promise<void> {
  const safeFilename = filename.endsWith('.csv') ? filename : `${filename}.csv`;
  const csvContent = buildCsvContent(headers, rows);

  // Check whether the sharing API is available in this environment
  const isSharingAvailable = await Sharing.isAvailableAsync();

  if (!isSharingAvailable || !FileSystem.cacheDirectory) {
    // Simulator / web fallback — log the content so developers can see it
    console.log(`[csvExport] Sharing not available. CSV content for "${safeFilename}":\n${csvContent}`);
    return;
  }

  const fileUri = `${FileSystem.cacheDirectory}${safeFilename}`;

  try {
    await FileSystem.writeAsStringAsync(fileUri, csvContent, {
      encoding: FileSystem.EncodingType.UTF8,
    });

    await Sharing.shareAsync(fileUri, {
      mimeType: 'text/csv',
      dialogTitle: `Export ${safeFilename}`,
      UTI: 'public.comma-separated-values-text', // iOS UTI
    });
  } catch (err) {
    console.error('[csvExport] Failed to export CSV:', err);
    throw err;
  }
}
