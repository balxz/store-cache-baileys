export default function makeOrderedDictionary(idGetter) {
  const array = [];
  const dict = {};

  const get = (id) => dict[id];

  const upsert = (item, mode = 'append') => {
    const id = idGetter(item);
    if (get(id)) return Object.assign(dict[id], item);
    if (mode === 'append') array.push(item);
    else array.unshift(item);
    dict[id] = item;
  };

  const remove = (item) => {
    const id = idGetter(item);
    const idx = array.findIndex((i) => idGetter(i) === id);
    if (idx === -1) return false;
    array.splice(idx, 1);
    delete dict[id];
    return true;
  };

  const updateAssign = (id, update) => {
    const item = get(id);
    if (!item) return false;
    Object.assign(item, update);
    return true;
  };

  const clear = () => {
    array.length = 0;
    for (const k of Object.keys(dict)) delete dict[k];
  };

  const filter = (fn) => {
    let i = 0;
    while (i < array.length) {
      if (!fn(array[i])) {
        delete dict[idGetter(array[i])];
        array.splice(i, 1);
      } else i++;
    }
  };

  return { array, get, upsert, remove, updateAssign, clear, filter, toJSON: () => array, fromJSON: (arr) => array.splice(0, array.length, ...arr) };
}
