"""End-to-end OPC UA read: real asyncua server in-process + the real adapter.

Fully local, no external server — exercises the actual networked read path
(connect, node handles, batched read_values) the SimAdapter can't.
"""
import asyncio
import socket

import pytest

pytest.importorskip("asyncua")
from asyncua import Server, ua  # noqa: E402

from plc_gateway.adapters.opcua import OPCUAAdapter  # noqa: E402
from plc_gateway.core.adapter import TagSpec  # noqa: E402


def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


async def _scenario() -> None:
    port = _free_port()
    endpoint = f"opc.tcp://127.0.0.1:{port}/t/"
    server = Server()
    await server.init()
    server.set_endpoint(endpoint)
    idx = await server.register_namespace("urn:stoptrack:test")
    obj = await server.get_objects_node().add_object(idx, "M")
    running = await obj.add_variable(ua.NodeId("Machine_Running", idx), "Machine_Running", True, ua.VariantType.Boolean)
    fault = await obj.add_variable(ua.NodeId("Fault_Code", idx), "Fault_Code", 0, ua.VariantType.Int16)

    tags = [
        TagSpec("running", f"ns={idx};s=Machine_Running", "bool"),
        TagSpec("faultCode", f"ns={idx};s=Fault_Code", "int"),
    ]

    async with server:
        adapter = OPCUAAdapter("M", tags, {"endpoint": endpoint})
        await adapter.connect()
        assert adapter.is_connected()

        assert await adapter.read_many(tags) == {"running": True, "faultCode": 0}

        await running.write_value(False, ua.VariantType.Boolean)
        await fault.write_value(4, ua.VariantType.Int16)
        assert await adapter.read_many(tags) == {"running": False, "faultCode": 4}

        # single read path too
        assert await adapter.read(tags[0]) is False

        await adapter.disconnect()
        assert not adapter.is_connected()


def test_opcua_adapter_reads_live_server():
    asyncio.run(_scenario())
