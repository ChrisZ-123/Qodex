"""Fixture tests cannot make outbound connections; loopback TestServer is allowed."""

import ipaddress
import socket

import pytest


def loopback(host):
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


@pytest.fixture(scope="session", autouse=True)
def forbid_outbound_network():
    patch = pytest.MonkeyPatch()
    original_connect = socket.socket.connect
    original_connect_ex = socket.socket.connect_ex
    original_lookup = socket.getaddrinfo

    def connect(sock, address):
        if not loopback(address[0]):
            raise AssertionError("Outbound network forbidden in Waves fixture tests")
        return original_connect(sock, address)

    def connect_ex(sock, address):
        if not loopback(address[0]):
            raise AssertionError("Outbound network forbidden in Waves fixture tests")
        return original_connect_ex(sock, address)

    def lookup(host, *args, **kwargs):
        if host is not None and not loopback(host):
            raise AssertionError("Outbound DNS forbidden in Waves fixture tests")
        return original_lookup(host, *args, **kwargs)

    patch.setattr(socket.socket, "connect", connect)
    patch.setattr(socket.socket, "connect_ex", connect_ex)
    patch.setattr(socket, "getaddrinfo", lookup)
    yield
    patch.undo()
