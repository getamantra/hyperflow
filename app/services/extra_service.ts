export class Extras {
  // This will dynamicalli generate a 32 character unique id.
  static generateKey(length: number): string {
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
    let result = ''
    const charactersLength = characters.length
    for (let i = 0; i < length; i++) {
      result += characters.charAt(Math.floor(Math.random() * charactersLength))
    }
    return result.toUpperCase()
  }

  // Recursively deep-merges newVariables into variableData in place (objects merge key by key,
  // arrays/primitives overwrite). Shared by the manual set-variables endpoint and the automatic
  // merge of variables an activity emits via outputData.variables on task completion.
  static mergeVariableData(variableData: any, newVariables: any) {
    for (const key of Object.keys(newVariables)) {
      if (
        newVariables[key] &&
        typeof newVariables[key] === 'object' &&
        !Array.isArray(newVariables[key])
      ) {
        if (
          !variableData[key] ||
          typeof variableData[key] !== 'object' ||
          Array.isArray(variableData[key])
        ) {
          variableData[key] = {}
        }
        Extras.mergeVariableData(variableData[key], newVariables[key])
      } else {
        variableData[key] = newVariables[key]
      }
    }
  }
}
