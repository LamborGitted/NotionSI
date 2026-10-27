// A real 1x1 PNG, kept local so tests never upload user data or contact a model.
export const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB1sAAAAASUVORK5CYII=', 'base64');
export const image = { type: 'image', mediaType: 'image/png', data: png.toString('base64') };
