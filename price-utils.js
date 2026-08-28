'use strict';

function parseAmazonPrice(html) {
  if (typeof html !== 'string' || /captcha|api-services-support@amazon\.com/i.test(html)) return null;
  const structured = html.match(/"priceAmount"\s*:\s*([0-9]+(?:\.[0-9]{1,2})?)[\s\S]{0,160}?"currencySymbol"\s*:\s*"€"/i);
  if (structured) {
    const value = Number(structured[1]);
    return Number.isFinite(value) && value > 0 && value < 10000 ? value : null;
  }
  const labelled = html.match(/data-pricetopay-label[^>]*>[\s\n\r]*([0-9.]+,[0-9]{2})\s*€/i);
  if (!labelled) return null;
  const value = Number(labelled[1].replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(value) && value > 0 && value < 10000 ? value : null;
}

module.exports = { parseAmazonPrice };
