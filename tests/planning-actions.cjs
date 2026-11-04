// Use the same secondary-action disclosure as a planner; dialogs retain their own assertions.
async function planningAction(page, name) {
  const trigger = page.locator('.planning-more > summary');
  if (await page.locator('.planning-more').getAttribute('open') === null) await trigger.click();
  await page.getByRole('group', {name: 'Additional planning actions', exact: true}).getByRole('button', {name, exact: true}).click();
}
module.exports = {planningAction};
