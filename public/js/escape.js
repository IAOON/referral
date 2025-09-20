/**
 * HTML Escape Utility
 * Prevents XSS attacks by escaping HTML special characters
 */

/**
 * Escapes HTML special characters to prevent XSS attacks
 * @param {string} text - The text to escape
 * @returns {string} - The escaped text safe for innerHTML
 */
function escapeHtml(text) {
    if (typeof text !== 'string') {
        return '';
    }
    
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;')
        .replace(/\//g, '&#x2F;');
}

/**
 * Escapes HTML special characters for use in HTML attributes
 * @param {string} text - The text to escape
 * @returns {string} - The escaped text safe for HTML attributes
 */
function escapeHtmlAttr(text) {
    if (typeof text !== 'string') {
        return '';
    }
    
    return text
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/**
 * Escapes JavaScript special characters for use in JavaScript strings
 * @param {string} text - The text to escape
 * @returns {string} - The escaped text safe for JavaScript strings
 */
function escapeJs(text) {
    if (typeof text !== 'string') {
        return '';
    }
    
    return text
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\t/g, '\\t');
}
