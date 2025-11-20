const fetch = require('node-fetch');


const request = async (url, options, headers) => {
	const response = await fetch(url, {
		headers: {
			Accept: 'application/json',
			'Content-Type': 'application/json',
			...headers
		},
		...options
	})
	if (!response.ok) {
		const error = await response.text()
		console.error('-- error', url, error)
		throw new Error(error)
	}
	const data = await response.json()
	return data
}

exports.request = request;
